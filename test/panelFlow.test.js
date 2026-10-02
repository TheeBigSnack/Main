// The side panel's own list starts posts and queues on the same state the
// popup's posts use, so these run sidepanel.js's own functions, as written,
// with the rest of the panel replaced by stubs (the way photoHosts.test.js
// runs canAutoOpen):
//   - a queue reads cars through the tab it was started from, and never
//     through a tab an earlier post or to-do item left behind;
//   - a car already marked as posted never gets a second Marketplace form;
//   - one list action at a time, with the action still called inside the click;
//   - a load for a website the panel has moved away from is dropped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { currentVin, advance } from '../extension/src/queue.js';
import { markPosted, diffScans } from '../extension/src/rescan.js';
import { logPost, capStatus, capCount } from '../extension/src/cap.js';
import { updateKey } from '../extension/src/storage.js';
import { runGuardrails, ruleProblems, buildTemplateDescription } from '../extension/src/rewriteTemplate.js';
import { buildListingData } from '../extension/src/listingData.js';
import { recheck } from '../extension/src/vehicleDetails.js';
import { basisPrice, snapshotEntry } from '../extension/src/rescan.js';
import { assessVehicle } from '../extension/src/classify.js';
import { draftRecord } from '../extension/src/drafts.js';
import { shortLocation, storeNames } from '../extension/src/normalize.js';
import { localVinCheck } from '../extension/src/vin.js';
import { FORM_MAP, applyOverrides } from '../extension/facebook/formMap.js';
import { isNewListingFromForm, onCreatePage, listingLink } from '../extension/facebook/detectPost.js';
import { vehicle } from './helpers.js';

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
// Several functions compiled in one scope, so they call each other as written.
function compileMany(names, scope) {
  const keys = Object.keys(scope);
  return new Function(...keys, `${names.map(fnText).join('\n')}\nreturn { ${names.join(', ')} };`)(...keys.map((k) => scope[k]));
}

test('a queue reads its cars through the tab it was started from, or through none', async () => {
  const run = async (queue, leftover, panelWindowId = null) => {
    const started = [];
    const state = { origin: 'https://www.example-dealer.test', queue, dealerTabId: leftover, windowId: 3 };
    const startNextInQueue = compile('startNextInQueue', {
      state, currentVin, dailyCap: () => ({ reached: false }), panelWindowId,
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
  assert.deepEqual([req.vin, req.queue, req.windowId], ['AAA', true, 9], 'a panel that cannot tell its window: the queue\'s');
  const fromPopup = { ...fromPanel, dealerTabId: 7 };
  assert.equal((await run(fromPopup, 41)).dealerTabId, 7, 'the popup\'s queue keeps its own dealer tab');
  assert.equal((await run({ ...fromPanel, dealerTabId: undefined }, 41)).dealerTabId, null, 'a queue that names no tab reads without one');
  // the car belongs to the panel walking the queue, wherever the queue was made
  assert.equal((await run(fromPopup, 41, 12)).windowId, 12, 'the walking panel\'s window, not the one the queue was made in');
  assert.equal((await run(fromPanel, 41, 9)).windowId, 9);
});

// A queue made in one window (the popup's, or before Chrome restarted, when
// window numbers change) and walked by the side panel of another window: from
// the second car on, the panel that opened and filled the form still records
// the post by itself when the tab goes straight to the new listing. Run with
// sidepanel.js's own startNextInQueue, startWatcher and postsWindow.
test('a queue walked by the side panel of another window still records each post by itself there', async () => {
  const ITEM = 'https://www.facebook.com/marketplace/item/556/';
  for (const [made, panelWindowId] of [[1, 2], [1, 1], [null, 2], [1, null]]) {
    const calls = [];
    const state = {
      origin: 'https://www.example-motors.test', vin: 'AAA', windowId: panelWindowId, queueMode: true, step: 'publish', fbTabId: 77, map: FORM_MAP, posted: {}, detected: null,
      queue: { vins: ['AAA', 'BBB'], index: 1, status: 'running', results: { AAA: 'posted' }, dealerTabId: 7, windowId: made },
    };
    const fns = compileMany(['startNextInQueue', 'startWatcher', 'postsWindow'], {
      state, currentVin, panelWindowId, isNewListingFromForm, watcher: null,
      dailyCap: () => ({ reached: false }), pauseQueue: never('pauseQueue'), saveQueue: never('saveQueue'), clearFlow: never('clearFlow'), setStatus: never('setStatus'), capCount: () => '',
      // startFlow as far as the form: it takes the request's window, then openForm and runFill start the watcher
      startFlow: async (req) => {
        calls.push(`start ${req.vin}`);
        Object.assign(state, { vin: req.vin, windowId: req.windowId || null, queueMode: true, step: 'publish', detected: null });
      },
      watchForListing: () => ({ promise: Promise.resolve({ status: 'listing', url: ITEM, id: '556', afterCreate: true }), cancel: () => {} }),
      confirmPosted: async () => calls.push('confirmPosted'), render: () => calls.push('render'), saveFlow: () => calls.push('saveFlow'),
    });
    await fns.startNextInQueue();
    fns.startWatcher();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, ['start BBB', 'confirmPosted'], `queue made in window ${made}, walked in window ${panelWindowId}: B is recorded by itself (${calls.join(' | ')})`);
  }
  // Allow and check again on a blocked car starts it again from this panel: it is this panel's post
  for (const [windowId, panelWindowId, expected] of [[1, 2, 2], [1, null, 1], [null, 2, 2]]) {
    const started = [];
    const allowSiteAndRetry = compile('allowSiteAndRetry', {
      state: { origin: 'https://www.example-motors.test', vin: 'AAA', windowId, queueMode: true, blockedOrigins: null },
      panelWindowId, askForSite: async () => true, missingOrigins: () => [], grantedOrigins: [], siteNeeds: () => [],
      startFlow: async (req) => started.push(req),
    });
    await allowSiteAndRetry();
    assert.deepEqual(started.map((r) => [r.vin, r.queue, r.windowId]), [['AAA', true, expected]], `blocked in window ${windowId}, retried in window ${panelWindowId}`);
  }
});

test('clearing a finished post forgets the tab and the window it came from', async () => {
  const state = { origin: 'https://www.example-dealer.test', vin: null, dealerTabId: 41, windowId: 3, step: 'done' };
  const clearFlow = compile('clearFlow', {
    state, watcher: null, flowRun: 0, pilotNote: never('pilotNote'), endPost: never('endPost'), FORM_MAP: {},
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
  const { startFlow } = compileMany(['startFlow', 'stopPosted'], {
    state,
    chrome: { storage: { local: { remove: async () => {} } } },
    GLOBAL_KEYS: { postRequest: 'postRequest' },
    endUpkeep: () => {},
    flowRun: 0,
    clearFlow: async () => {
      calls.push('clearFlow');
      return 0;
    },
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

// A car marked as posted after its review began (the popup's Mark posted, or
// a colleague's post brought down by the sync while the car waits at review):
// Open the Marketplace form and the dry run's Fill it in now read the posted
// list as it is stored then, and stop (stopPosted) before any tab opens or
// anything is typed.
test('a car marked as posted while it waits at review gets no form: Open the Marketplace form and Fill it in now check the stored list first', async () => {
  const v = vehicle('usedNormal');
  const description = buildTemplateDescription({ vehicle: v, dealer: DEALER, salesperson: { name: 'Pat', title: 'sales consultant' } });
  const colleague = { 'posted:https://www.example-motors.test': { [v.vin]: { name: v.name, price: v.price, postedAt: new Date().toISOString(), mine: false } } };
  for (const queueMode of [false, true]) {
    for (const step of ['review', 'probe']) {
      const stops = [];
      const o = formOpener({ description, step, stored: colleague, extra: { stopPosted: async () => stops.push(`${o.state.vin} queue=${o.state.queueMode}`) } });
      o.state.queueMode = queueMode;
      if (step === 'review') await o.fns.openForm();
      else await o.fns.fillFromProbe();
      const what = `${queueMode ? 'queued' : 'single'} car at ${step}`;
      assert.deepEqual(o.forms, [], `${what}: no Marketplace tab (${o.calls.join(' | ')})`);
      assert.ok(!o.calls.some((c) => c.startsWith('runFill') || c === 'runProbe'), `${what}: nothing filled`);
      assert.deepEqual(stops, [`${v.vin} queue=${queueMode}`], `${what}: stopped as posted`);
      assert.ok(o.state.posted[v.vin], `${what}: the panel holds the stored list`);
    }
  }
  // not posted: the form opens as before
  const free = formOpener({ description, extra: { stopPosted: never('stopPosted') } });
  await free.fns.openForm();
  assert.deepEqual(free.forms, [`${v.vin} while vin=${v.vin}`]);
});

// Fill it in now first fills the form the dry run opened. The dry run was
// opened under the cap, but it may have stayed open (or come back when the
// panel reopened, the next day too) while posts were counted elsewhere: a
// sync from the person's other computer, a car marked posted in the popup,
// a form saved as a draft. Fill it in now reads the day's counts again and
// fills nothing at the cap, and the probe view draws it off there.
test('Fill it in now on the dry run\'s form reads the day\'s counts again and fills nothing at the daily cap; the probe view draws it off there', async () => {
  const v = vehicle('usedNormal');
  const description = buildTemplateDescription({ vehicle: v, dealer: DEALER, salesperson: { name: 'Pat', title: 'sales consultant' } });
  const origin = 'https://www.example-motors.test';
  const now = new Date();
  const at = now.toISOString();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  // the panel's own dailyCap, run on the state the opener holds
  const capExpr = /const dailyCap = ([^;]+);/.exec(src)[1];
  const realCap = (state) => new Function('capStatus', 'state', `return ${capExpr};`)(capStatus, state);
  const ten = (make) => Array.from({ length: 10 }, (_, i) => make(i));
  const elsewhere = {
    'a sync counted 10 posts from another computer': { [`sync:${origin}`]: { postsToday: { count: 10, from: dayStart.toISOString(), to: dayEnd.toISOString() } } },
    'the day\'s log has 10 posts': { [`postLog:${origin}`]: ten((i) => ({ vin: `LOG${i}`, at })) },
    '10 forms were saved as drafts today': { [`drafts:${origin}`]: Object.fromEntries(ten((i) => [`DRAFT${i}`, { savedAt: at }])) },
    'the popup marked 10 cars posted': { [`posted:${origin}`]: Object.fromEntries(ten((i) => [`MARK${i}`, { name: 'a car', price: 1, postedAt: at }])) },
  };
  for (const [what, stored] of Object.entries(elsewhere)) {
    let o = null;
    o = formOpener({ description, step: 'probe', stored, extra: { dailyCap: () => realCap(o.state)(), capCount, stopPosted: never('stopPosted') } });
    assert.equal(realCap(o.state)().reached, false, `${what}: the panel itself still counts 0`);
    await o.fns.fillFromProbe();
    assert.ok(!o.calls.some((c) => c.startsWith('runFill')), `${what}: nothing filled (${o.calls.join(' | ')})`);
    assert.ok(o.calls.some((c) => c.startsWith('status(error): Daily post cap reached (10 of 10 today')), `${what}: the cap is said (${o.calls.join(' | ')})`);
    assert.ok(o.calls.includes('render:probe'), `${what}: the probe view is drawn again, its button off`);
    assert.deepEqual(o.forms, [], `${what}: no Marketplace tab`);
  }
  // under the cap (9 elsewhere), the form is filled as before
  let under = null;
  under = formOpener({
    description, step: 'probe', stored: { [`sync:${origin}`]: { postsToday: { count: 9, from: dayStart.toISOString(), to: dayEnd.toISOString() } } },
    extra: { dailyCap: () => realCap(under.state)(), capCount, stopPosted: never('stopPosted') },
  });
  await under.fns.fillFromProbe();
  assert.equal(under.calls.filter((c) => c.startsWith('runFill')).length, 1, `under the cap: filled once (${under.calls.join(' | ')})`);

  // the probe view: Fill it in now is drawn off at the cap, with the cap said
  let cap = { reached: false, used: 9, cap: 10, remaining: 1 };
  const blank = () => '';
  const state = { probe: { found: [{ key: 'year', label: 'Year', tag: 'input', name: 'Year' }], missing: [], controls: [] }, map: { version: 'test' } };
  const viewProbe = compile('viewProbe', {
    state, dailyCap: () => cap, capCount, VERSION: 'test', esc: (x) => String(x ?? ''),
    carCard: blank, readAgainHtml: blank, languageHint: blank, photoServersHtml: blank,
  });
  assert.match(viewProbe(), /id="fillNow" >/, 'under the cap: on');
  assert.doesNotMatch(viewProbe(), /Daily post cap reached/);
  cap = { reached: true, used: 10, cap: 10, remaining: 0 };
  assert.match(viewProbe(), /id="fillNow" disabled/, 'at the cap: off');
  assert.match(viewProbe(), /Daily post cap reached \(10 of 10 today\)/, 'at the cap: said');
  state.probe.found = [];
  cap = { reached: false, used: 0, cap: 10, remaining: 10 };
  assert.match(viewProbe(), /id="fillNow" disabled/, 'no field found: off, as before');
});

// A post saved at the dry run or at Publish comes back when the panel
// reopens. The form map is built again from formMap.js (with the test hook's
// addresses only), never taken from the saved post: a map fixed in a newer
// version applies, and nothing in storage widens what the fill may touch.
test('a post that comes back when the panel reopens uses the form map this version ships, never one saved with the post', async () => {
  const v = vehicle('usedNormal');
  const description = buildTemplateDescription({ vehicle: v, dealer: DEALER, salesperson: { name: 'Pat', title: 'sales consultant' } });
  const saved = { ...FORM_MAP, version: 'from-storage', fields: [{ key: 'publish', label: 'Publish', kind: 'choice', name: ['^next\\b|^publish\\b'] }], fileInput: '[role="button"]', listingUrlPattern: '.' };
  assert.ok(!FLOW_FIELDS.includes('map'), 'a saved post does not carry the map');
  for (const step of ['probe', 'publish']) {
    const o = formOpener({ description, step: 'idle', stored: { devOverrides: { createUrl: 'http://127.0.0.1:1/marketplace/create/vehicle', fields: [] } }, extra: { applyOverrides } });
    await o.fns.resumeFlow(o.state.origin, { vin: v.vin, step, vehicle: v, price: v.price, description, fbTabId: null, map: saved });
    assert.equal(o.state.step, step);
    assert.equal(o.state.map.fields, FORM_MAP.fields, `${step}: the fields are formMap.js's`);
    assert.equal(o.state.map.fileInput, FORM_MAP.fileInput);
    assert.equal(o.state.map.listingUrlPattern, FORM_MAP.listingUrlPattern);
    assert.equal(o.state.map.version, FORM_MAP.version, `${step}: the version reported is this one's`);
    assert.equal(o.state.map.createUrl, 'http://127.0.0.1:1/marketplace/create/vehicle', 'the test hook still moves the address');
  }
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

// Opening the form, compiled with sidepanel.js's own checks and the real
// guardrails and listing builder; the tab, the fill and the probe are stubs
// that record they were reached. `description` is what the box holds.
const DEALER = { name: 'Example Motors', city: 'Exampletown', state: 'PA', zip: '15000' };
const READ_MAX_AGE_MS = Number(new Function(`return ${/const READ_MAX_AGE_MS = ([^;]+);/.exec(src)[1]}`)());
const LIVE_STEPS = new Function(`return ${/const LIVE_STEPS = (\[[^\]]*\]);/.exec(src)[1]}`)();
const FLOW_FIELDS = new Function(`return ${/const FLOW_FIELDS = (\[[^\]]*\]);/.exec(src)[1]}`)();
// also: more of sidepanel.js's functions compiled into the same scope (a
// post request arriving while the form is being opened); their other calls
// are stubs that record they ran. autoOpen: what canAutoOpen says (a queued
// car that passes every check opens its form by itself); gen: the stand-in
// for writing the description, given the state.
function formOpener({ description, step = 'review', readAt = new Date().toISOString(), read = null, car = vehicle('usedNormal'), also = [], autoOpen = false, gen = null, tabLoad = null, stored = {}, extra = {} }) {
  const v = car;
  const calls = [];
  const forms = []; // each Marketplace tab opened: the car it was opened for, and the post the panel was on
  const box = { value: description };
  const state = {
    origin: 'https://www.example-motors.test', vin: v.vin, step, vehicle: v, price: v.price, noteApplies: true, readAt,
    description, settings: { dealer: DEALER, defaults: {}, basis: 'website', priceNote: '', salesperson: { name: 'Pat', title: 'sales consultant', closingLine: '' }, dailyCap: 10 },
    posted: {}, colorGuess: null, listing: null, snapshotVehicles: {}, siteInfo: null, dealerTabId: 41, map: FORM_MAP, photoPick: null,
  };
  const ctx = () => ({ vehicle: state.vehicle, dealer: state.settings.dealer, priceNote: '', price: state.price, closingLine: '' });
  // the dry run built the listing when it opened the form
  if (step === 'probe') state.listing = buildListingData(v, { dealer: DEALER, description, price: v.price, photos: [] });
  const fns = compileMany(['resumeFlow', 'descriptionStopped', 'readIsOld', 'readCarNow', 'takeCar', 'formValues', 'carStillCurrent', 'readStoredCounts', 'openForm', 'fillFromProbe', ...also], {
    state, ctx, runGuardrails, ruleProblems, buildListingData, READ_MAX_AGE_MS, FLOW_FIELDS, flowRun: 0,
    FORM_STEPS: new Function(`return ${/const FORM_STEPS = (\[[^\]]*\]);/.exec(src)[1]}`)(),
    watcher: null, endPost: () => {}, beginPost: () => {}, endUpkeep: () => {}, refreshGranted: async () => {}, nameOf: (vin) => vin,
    afterQueueStep: async (outcome) => calls.push('afterQueueStep ' + outcome), canAutoOpen: () => autoOpen, maybeGuessColors: async () => {},
    generate: async () => {
      calls.push(`generate ${state.vin} with ${state.vehicle.vin}`);
      if (gen) return gen(state);
      state.description = `Pre-owned at ${DEALER.name}. VIN ${state.vehicle.vin}.`;
      return undefined;
    },
    LIVE_STEPS, postUnderWay: () => Boolean(state.vin) && LIVE_STEPS.includes(state.step),
    finishFirstText: (button) => `Finish or stop the current post first. Then click ${button} again.`,
    loadSaved: async () => true, startWatcher: () => calls.push('startWatcher'),
    recheck, basisPrice, shortLocation, storeNames, localVinCheck, money: (n) => '$' + n.toLocaleString('en-US'),
    block: async (message, code) => {
      calls.push('block: ' + code);
      Object.assign(state, { step: 'blocked', message });
    },
    $: (id) => (id === 'description' && step === 'review' ? box : null),
    checksHtml: () => '', setFormButtons: () => calls.push('buttons'),
    setStatus: (text, kind) => calls.push(`status${kind ? '(' + kind + ')' : ''}: ${text}`),
    siteKeys: (o) => ({ posted: 'posted:' + o, postLog: 'postLog:' + o, sync: 'sync:' + o, drafts: 'drafts:' + o, flow: 'postFlow:' + o }),
    dailyCap: () => ({ reached: false, used: 0, cap: 10 }),
    pickedPhotos: () => [],
    render: () => calls.push('render:' + state.step), saveFlow: async () => {}, pilotNote: async () => {}, notePostStep: () => {},
    GLOBAL_KEYS: { devOverrides: 'devOverrides', postRequest: 'postRequest' }, FORM_MAP, applyOverrides: (m) => m,
    chrome: { storage: { local: { get: async () => ({ ...stored }), remove: async () => {} } }, tabs: { create: async () => { calls.push('tabs.create'); forms.push(`${state.vehicle ? state.vehicle.vin : '(no car)'} while vin=${state.vin}`); return { id: 77 }; } } },
    waitForTabLoad: async (id) => (tabLoad ? tabLoad(id) : undefined), sleep: async () => {},
    runFill: async () => calls.push(`runFill: ${state.listing ? state.listing.fields.description : '(no listing)'}`),
    runProbe: async () => calls.push('runProbe'),
    readCarForPost: async (req) => {
      calls.push(`readCarForPost ${req.vin} tab ${req.tabId}`);
      return (read || never('readCarForPost'))(req);
    },
    ...extra,
  });
  return { state, calls, fns, v, forms, box };
}

test('a description that breaks a posting rule is never typed into the form; a style warning alone does not stop it', async () => {
  const v = vehicle('usedNormal');
  const write = (car) => buildTemplateDescription({ vehicle: car, dealer: DEALER, salesperson: { name: 'Pat', title: 'sales consultant' } });
  const good = write(v);
  const checked = runGuardrails(good, { vehicle: v, dealer: DEALER, price: v.price });
  // this record has no features on the website, so its own template is a little short: a warning, not a stop
  assert.deepEqual([checked.ok, checked.problems.map((p) => p.code), ruleProblems(checked)], [false, ['too-short'], []]);
  const noCarfax = { ...v, carfaxOneOwner: false, carfaxUrl: '' };
  const cases = {
    'the dealership deleted': [v, good.replaceAll(DEALER.name, 'the lot')],
    'an invented payment': [v, good + '\nOnly $199 a month.'],
    'posing as a private seller': [v, 'Selling my truck. ' + good],
    'a one-owner claim the data lacks': [noCarfax, write(noCarfax) + '\nOne owner, garage kept.'],
  };
  for (const [what, [car, description]] of Object.entries(cases)) {
    for (const probeOnly of [false, true]) {
      const o = formOpener({ description, car });
      await o.fns.openForm({ probeOnly });
      assert.ok(!o.calls.includes('tabs.create'), `${what}: the form is not opened (${probeOnly ? 'check fields' : 'fill'})`);
      assert.ok(o.calls.some((c) => /^status\(error\): Fix the description first: /.test(c)), `${what}: the status line says what to fix`);
      assert.ok(ruleProblems(o.state.guardrails).length > 0);
    }
    // the dry run's Fill it in now checks the same text before filling
    const p = formOpener({ description, step: 'probe', car });
    await p.fns.fillFromProbe();
    assert.ok(!p.calls.some((c) => c.startsWith('runFill')), `${what}: Fill it in now does not fill`);
  }
  // only style warnings: the sparse record's own template, and a very short text that names the dealership
  for (const text of [good, `Pre-owned at ${DEALER.name}. VIN ${v.vin}.`]) {
    const g = runGuardrails(text, { vehicle: v, dealer: DEALER, price: v.price });
    assert.ok(!g.ok && ruleProblems(g).length === 0, 'too short is a warning, not a rule');
    const o = formOpener({ description: text });
    await o.fns.openForm();
    assert.deepEqual(o.calls.filter((c) => c === 'tabs.create' || c.startsWith('runFill')), ['tabs.create', `runFill: ${text}`]);
    const p = formOpener({ description: text, step: 'probe' });
    await p.fns.fillFromProbe();
    assert.ok(p.calls.some((c) => c.startsWith('runFill')), 'Fill it in now fills it');
  }
  // the text checked is the one in the box, not an older copy in the state
  const edited = formOpener({ description: good });
  edited.state.description = good.replaceAll(DEALER.name, 'the lot');
  await edited.fns.openForm();
  assert.ok(edited.calls.includes('tabs.create'), 'the box holds the good text');
});

test('an old read of the car is read and checked again before the form opens or fills: a car that changed on the website is never filled from the old read', async () => {
  const v = vehicle('usedNormal');
  const description = buildTemplateDescription({ vehicle: v, dealer: DEALER, salesperson: { name: 'Pat', title: 'sales consultant' } });
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const opened = (calls) => calls.filter((c) => c === 'tabs.create' || c.startsWith('runFill') || c === 'runProbe');
  const as = (patch) => async () => ({ ok: true, vehicle: { ...v, ...patch } });

  // a fresh read: nothing is read again (the queue opens the form straight after its own read)
  const fresh = formOpener({ description });
  await fresh.fns.openForm();
  assert.deepEqual(opened(fresh.calls), ['tabs.create', `runFill: ${description}`]);

  // a review brought back the next day, or one saved before reads were timed: read again first, and filled when nothing changed
  for (const readAt of [new Date(Date.now() - 26 * 3600 * 1000).toISOString(), null, 'garbage']) {
    const o = formOpener({ description, readAt, read: as({}) });
    await o.fns.openForm();
    const read = o.calls.findIndex((c) => c.startsWith('readCarForPost'));
    assert.ok(read >= 0 && read < o.calls.indexOf('tabs.create'), `read again before the tab opens (${readAt})`);
    assert.equal(o.calls[read], `readCarForPost ${v.vin} tab 41`);
    assert.ok(Date.now() - Date.parse(o.state.readAt) < 5000, 'the new read is recorded');
    assert.deepEqual(o.calls.filter((c) => c.startsWith('render:')), ['render:checking', 'render:filling'], 'the panel says it is checking, then opens the form');
  }
  // the panel reopened on Monday's review, saved with Monday's read: read again before the form opens
  assert.ok(FLOW_FIELDS.includes('readAt'), 'the read time is saved with the post');
  const monday = formOpener({ description: '', step: 'idle', read: as({}) });
  const saved = { vin: v.vin, vehicle: v, price: v.price, readAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(), description, step: 'review', map: FORM_MAP };
  await monday.fns.resumeFlow(monday.state.origin, saved);
  assert.equal(monday.state.step, 'review');
  await monday.fns.openForm();
  assert.ok(monday.calls.findIndex((c) => c.startsWith('readCarForPost')) < monday.calls.indexOf('tabs.create') && monday.calls.includes('tabs.create'));

  // just inside the limit: no read
  const inside = formOpener({ description, readAt: new Date(Date.now() - READ_MAX_AGE_MS + 60000).toISOString() });
  await inside.fns.openForm();
  assert.ok(inside.calls.includes('tabs.create'));

  // the website now says new, or sale pending, or it is gone, or has no price: stopped, nothing opened
  const stops = {
    'retyped as new': [as({ inventoryType: 'New', readableType: 'New', urlConditionWord: 'new', siteTitle: 'New ' + v.name }), /^block: check-skip$/],
    'sale pending': [as({ status: 'pend-sale' }), /^block: check-not-ready$/],
    'gone from the website': [async () => ({ ok: false, notFound: true, message: 'This car is no longer on the website.' }), /^block: not-on-website$/],
    'website unreachable': [async () => ({ ok: false, message: "Couldn't reach the website." }), /^block: site-unreachable$/],
    'no price': [as({ price: null, priceBeforeFees: null }), /^block: (no-price|check-not-ready)$/], // the gate itself holds a car with no price
  };
  for (const [what, [read, code]] of Object.entries(stops)) {
    for (const probeOnly of [false, true]) {
      const o = formOpener({ description, readAt: hourAgo, read });
      await o.fns.openForm({ probeOnly });
      assert.deepEqual(opened(o.calls), [], `${what}: nothing opened`);
      assert.ok(o.calls.some((c) => code.test(c)), `${what}: ${o.calls.join(' | ')}`);
      assert.equal(o.state.step, 'blocked');
    }
    const p = formOpener({ description, readAt: hourAgo, step: 'probe', read });
    await p.fns.fillFromProbe();
    assert.deepEqual(opened(p.calls), [], `${what}: Fill it in now fills nothing`);
  }

  // the price dropped $1,500: back at review with the new price, said in the status line; nothing opened
  const drop = formOpener({ description, readAt: hourAgo, read: as({ price: v.price - 1500 }) });
  await drop.fns.openForm();
  assert.deepEqual(opened(drop.calls), []);
  assert.equal(drop.state.step, 'review');
  assert.equal(drop.state.price, v.price - 1500);
  assert.ok(drop.calls.some((c) => c.startsWith('status(error): The website changed this car since it was read (price $' + v.price.toLocaleString('en-US') + ' to $' + (v.price - 1500).toLocaleString('en-US') + ')')), drop.calls.join(' | '));
  // and the next click goes on from the new read, with the new price
  await drop.fns.openForm();
  assert.deepEqual(opened(drop.calls), ['tabs.create', `runFill: ${description}`]);
  assert.equal(drop.state.listing.fields.price, String(v.price - 1500));

  // the mileage went up: the description's number no longer matches, so the checks stop the next click until it is fixed
  const miles = formOpener({ description, readAt: hourAgo, read: as({ mileage: v.mileage + 250 }) });
  await miles.fns.openForm();
  assert.ok(miles.calls.some((c) => /^status\(error\): The website changed this car since it was read \(mileage\)/.test(c)), miles.calls.join(' | '));
  assert.ok(ruleProblems(miles.state.guardrails).some((p) => p.code === 'unknown-number'));
  await miles.fns.openForm();
  assert.deepEqual(opened(miles.calls), [], 'the old mileage in the text is not filled');

  // the dry run's Fill it in now on an old read: the same
  const probe = formOpener({ description, readAt: hourAgo, step: 'probe', read: as({ price: v.price + 500 }) });
  await probe.fns.fillFromProbe();
  assert.deepEqual(opened(probe.calls), []);
  assert.equal(probe.state.step, 'review');
  const same = formOpener({ description, readAt: hourAgo, step: 'probe', read: as({}) });
  await same.fns.fillFromProbe();
  assert.deepEqual(opened(same.calls), [`runFill: ${description}`]);
  assert.equal(same.state.step, 'probe', 'back on the dry run, which the fill then moves on');
});

test('after the re-read, the description is checked against the car as the website shows it now: a fact it no longer gives stops the form even when no form value changed', async () => {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const opened = (calls) => calls.filter((c) => c === 'tabs.create' || c.startsWith('runFill') || c === 'runProbe');
  const write = (car) => buildTemplateDescription({ vehicle: car, dealer: DEALER, salesperson: { name: 'Pat', title: 'sales consultant' } });
  const certified = vehicle('certified');
  const featured = { ...vehicle('usedNormal'), features: ['22-inch wheels'] };
  const cases = {
    // the Carfax one-owner flag: set when the description was written, cleared on the website since
    'the one-owner flag cleared': [certified, { carfaxOneOwner: false }, 'one-owner'],
    // a feature the description names, with its number, gone from the website's list since
    'a feature with a number dropped': [featured, { features: [] }, 'unknown-number'],
  };
  for (const [what, [car, patch, code]] of Object.entries(cases)) {
    const text = write(car);
    const now = { ...car, ...patch };
    assert.deepEqual(ruleProblems(runGuardrails(text, { vehicle: car, dealer: DEALER, price: car.price })), [], `${what}: the text passes against the old read`);
    assert.deepEqual(buildListingData(now, { dealer: DEALER, description: '', price: now.price, photos: [] }).fields, buildListingData(car, { dealer: DEALER, description: '', price: car.price, photos: [] }).fields, `${what}: no form value changed`);
    const read = async () => ({ ok: true, vehicle: { ...now } });
    for (const probeOnly of [false, true]) {
      const o = formOpener({ description: text, car, readAt: hourAgo, read });
      await o.fns.openForm({ probeOnly });
      assert.deepEqual(opened(o.calls), [], `${what}: nothing opened (${probeOnly ? 'check fields' : 'fill'})`);
      assert.equal(o.state.step, 'review', `${what}: back at the review`);
      assert.ok(o.calls.includes('render:review'), `${what}: the review is drawn again`);
      const stops = ruleProblems(o.state.guardrails);
      assert.ok(stops.some((p) => p.code === code), `${what}: the checks are the new read's (${stops.map((p) => p.code)})`);
      const line = o.calls.find((c) => c.startsWith('status(error): The website changed this car since it was read'));
      assert.ok(line && stops.every((p) => line.includes(p.text)), `${what}: the status line says what to fix: ${o.calls.join(' | ')}`);
      // the next click is stopped too, until the description is fixed
      await o.fns.openForm();
      assert.deepEqual(opened(o.calls), [], `${what}: the old text is not filled on the next click`);
    }
    // the dry run's Fill it in now: the same
    const p = formOpener({ description: text, car, readAt: hourAgo, step: 'probe', read });
    await p.fns.fillFromProbe();
    assert.deepEqual(opened(p.calls), [], `${what}: Fill it in now fills nothing`);
    assert.equal(p.state.step, 'review');
  }
  // the person takes the claim out: the form opens from the new read, with no third read (it is fresh)
  const o = formOpener({ description: write(certified), car: certified, readAt: hourAgo, read: async () => ({ ok: true, vehicle: { ...certified, carfaxOneOwner: false } }) });
  await o.fns.openForm();
  o.box.value = write(certified).replace(/^One owner according to the Carfax report\.\n/m, '');
  await o.fns.openForm();
  assert.deepEqual(opened(o.calls), ['tabs.create', `runFill: ${o.box.value}`]);
  assert.equal(o.calls.filter((c) => c.startsWith('readCarForPost')).length, 1);
});

test('a Post for another car, the same car again, or Stop queue while the form waits on its re-read: no form opens for the post left behind, the same car is not started over, and a read never lands in another post', async () => {
  const A = vehicle('usedNormal');
  const B = vehicle('certified');
  const description = buildTemplateDescription({ vehicle: A, dealer: DEALER, salesperson: { name: 'Pat', title: 'sales consultant' } });
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const panel = (opener) => {
    const answers = {};
    const o = formOpener({
      description, car: A, readAt: hourAgo, step: opener === 'fillFromProbe' ? 'probe' : 'review',
      also: ['clearFlow', 'startFlow', 'postRequested', 'formOpen'],
      read: (req) => new Promise((resolve) => { (answers[req.vin] ||= []).push(resolve); }),
    });
    // answer(vin, value): the website answers the oldest read of that car still waiting
    const answer = (vin, value) => answers[vin].shift()(value);
    return { ...o, answer, open: () => o.fns[opener]() };
  };
  const nothingOpened = (o, what) => {
    assert.deepEqual(o.forms, [], `${what}: no Marketplace tab opens`);
    assert.ok(!o.calls.some((c) => c.startsWith('runFill') || c === 'runProbe'), `${what}: nothing is filled`);
  };
  for (const opener of ['openForm', 'fillFromProbe']) {
    // a Post for car B arrives while A is being read again; A's read answers next, unchanged
    const other = panel(opener);
    const opening = other.open();
    await tick();
    assert.deepEqual([other.state.step, other.fns.formOpen()], ['checking', false], 'nothing is on Facebook yet, so a new post may start');
    const posting = other.fns.postRequested({ origin: other.state.origin, vin: B.vin, dealerTabId: 9 });
    await tick();
    other.answer(A.vin, { ok: true, vehicle: { ...A } });
    await opening;
    nothingOpened(other, `${opener}, Post for B`);
    other.answer(B.vin, { ok: true, vehicle: { ...B } });
    await posting;
    assert.deepEqual([other.state.vin, other.state.vehicle.vin, other.state.price, other.state.step], [B.vin, B.vin, B.price, 'review'], 'B\'s post holds B');
    nothingOpened(other, `${opener}, after B's read`);

    // A's read fails after B took over: B's post is not stopped with A's reason
    const failed = panel(opener);
    const failing = failed.open();
    await tick();
    const posting2 = failed.fns.postRequested({ origin: failed.state.origin, vin: B.vin, dealerTabId: 9 });
    await tick();
    failed.answer(A.vin, { ok: false, notFound: true, message: 'This car is no longer on the website.' });
    await failing;
    assert.ok(!failed.calls.some((c) => c.startsWith('block')), `${opener}: ${failed.calls.join(' | ')}`);
    failed.answer(B.vin, { ok: true, vehicle: { ...B } });
    await posting2;
    assert.deepEqual([failed.state.vin, failed.state.step], [B.vin, 'review']);

    // the same car again (Continue in the side panel): the panel stays on A's post, which is read once and goes on to one form
    const again = panel(opener);
    const first = again.open();
    await tick();
    await again.fns.postRequested({ origin: again.state.origin, vin: A.vin, dealerTabId: 9 });
    assert.equal(again.calls.filter((c) => c.startsWith('readCarForPost')).length, 1, 'A is not started over');
    again.answer(A.vin, { ok: true, vehicle: { ...A } });
    await first;
    assert.deepEqual(again.forms, opener === 'openForm' ? [`${A.vin} while vin=${A.vin}`] : [], `${opener}, the same car again: one form, A's`);
    assert.deepEqual(again.calls.filter((c) => c.startsWith('runFill') || c === 'runProbe'), [`runFill: ${description}`], `${opener}, the same car again: filled once`);

    // Stop queue (or Back, or Skip this car, which starts the next car) clears the post while it is read: nothing opens afterwards
    const stopped = panel(opener);
    const stopping = stopped.open();
    await tick();
    await stopped.fns.clearFlow();
    stopped.answer(A.vin, { ok: true, vehicle: { ...A } });
    await stopping;
    nothingOpened(stopped, `${opener}, stopped`);
    assert.deepEqual([stopped.state.step, stopped.state.vin, stopped.state.vehicle], ['idle', null, null], 'the cleared post stays cleared');
  }
});

// Two posts started close together (Post on one car, then Post N cars or
// another Post; a double click; Skip this car while the next is read): the
// post left behind stops at its next step, whichever order the website and
// the description writer answer in. One form opens, for the car the panel is
// on, and that car's post holds only its own read.
test('two posts started close together never run into each other: one form, for the car the panel is on', async () => {
  const A = vehicle('usedNormal');
  const B = vehicle('certified');
  const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
  const make = () => {
    const reads = {};
    const gens = [];
    const o = formOpener({
      description: '', step: 'idle', autoOpen: true, also: ['clearFlow', 'startFlow', 'postRequested', 'formOpen'],
      read: (req) => new Promise((resolve) => { (reads[req.vin] ||= []).push(resolve); }),
      // the description is written from the car read for this post, and lands when the writer answers
      gen: (state) => {
        const text = `Pre-owned at ${DEALER.name}. VIN ${state.vehicle.vin}.`;
        return new Promise((resolve) => gens.push({ vin: state.vehicle.vin, done: () => { state.description = text; resolve(); } }));
      },
    });
    Object.assign(o.state, { vin: null, vehicle: null, step: 'idle', queueMode: false });
    const waiting = (vin) => (reads[vin] || []).length;
    const answer = (vin, car) => reads[vin].shift()({ ok: true, vehicle: { ...car } });
    const write = (vin) => gens.splice(gens.findIndex((g) => g.vin === vin), 1)[0].done();
    const post = (vin, queue = true) => o.fns.postRequested({ origin: o.state.origin, vin, dealerTabId: 9, queue });
    return { ...o, waiting, answer, write, post };
  };
  const onlyB = (o, what) => {
    assert.deepEqual(o.forms, [`${B.vin} while vin=${B.vin}`], `${what}: one form, B's (${o.calls.join(' | ')})`);
    assert.deepEqual([o.state.vin, o.state.vehicle.vin, o.state.price, o.state.step], [B.vin, B.vin, B.price, 'filling'], `${what}: B's post holds B, its form being filled`);
    assert.deepEqual(o.calls.filter((c) => c.startsWith('runFill')), [`runFill: Pre-owned at ${DEALER.name}. VIN ${B.vin}.`], `${what}: filled once, with B's text`);
    assert.equal(o.state.description, `Pre-owned at ${DEALER.name}. VIN ${B.vin}.`, `${what}: B's description`);
  };

  // A is read first; B's queue starts while A's description is written; then A's writer answers
  const inOrder = make();
  const a1 = inOrder.post(A.vin, false);
  await tick();
  inOrder.answer(A.vin, A);
  await tick();
  const b1 = inOrder.post(B.vin);
  await tick();
  assert.equal(inOrder.waiting(B.vin), 1, 'B is being read');
  inOrder.write(A.vin); // the post left behind: goes no further
  await a1;
  assert.deepEqual(inOrder.forms, [], 'nothing opened for A');
  inOrder.answer(B.vin, B);
  await tick();
  inOrder.write(B.vin);
  await b1;
  onlyB(inOrder, 'A read first');

  // B's read answers first, A's last
  const outOfOrder = make();
  const a2 = outOfOrder.post(A.vin, false);
  await tick();
  const b2 = outOfOrder.post(B.vin);
  await tick();
  outOfOrder.answer(B.vin, B);
  await tick();
  outOfOrder.write(B.vin);
  await b2;
  outOfOrder.answer(A.vin, A);
  await a2;
  onlyB(outOfOrder, 'A read last');

  // B's request arrives before A is even read (a double click, Post then Post N cars at once): only B is read
  const atOnce = make();
  const a3 = atOnce.post(A.vin, false);
  const b3 = atOnce.post(B.vin);
  await tick(10);
  assert.deepEqual([atOnce.waiting(A.vin), atOnce.waiting(B.vin)], [0, 1], `only B is read (${atOnce.calls.join(' | ')})`);
  atOnce.answer(B.vin, B);
  await tick();
  atOnce.write(B.vin);
  await Promise.all([a3, b3]);
  onlyB(atOnce, 'both at once');

  // the same car twice at once (a double click on Post N cars): read once, one form
  const twice = make();
  const t1 = twice.post(B.vin);
  const t2 = twice.post(B.vin);
  await tick(10);
  assert.equal(twice.waiting(B.vin), 1, `B is read once (${twice.calls.join(' | ')})`);
  twice.answer(B.vin, B);
  await tick();
  twice.write(B.vin);
  await Promise.all([t1, t2]);
  onlyB(twice, 'the same car twice');
});

// The steps of a post that wait on the Marketplace tab, the rewrite service
// or the photo downloads: a post dropped meanwhile (Skip this car, Stop
// queue, another post) gets no form, no fill, no photos and no text.
test('a post dropped while its form loads, fills or gets its photos, or while its text is written, goes no further', async () => {
  const v = vehicle('usedNormal');
  const description = buildTemplateDescription({ vehicle: v, dealer: DEALER, salesperson: { name: 'Pat', title: 'sales consultant' } });
  const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
  const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

  // openForm: the tab is loading when the post is dropped
  const load = deferred();
  const o = formOpener({ description, also: ['clearFlow'], tabLoad: () => load.promise });
  const opening = o.fns.openForm();
  await tick();
  assert.deepEqual(o.forms, [`${v.vin} while vin=${v.vin}`]);
  await o.fns.clearFlow();
  load.resolve();
  await opening;
  assert.ok(!o.calls.some((c) => c.startsWith('runFill')), `nothing filled into the tab (${o.calls.join(' | ')})`);
  assert.deepEqual([o.state.step, o.state.fbTabId], ['idle', null]);

  // runFill and attachPhotos, as written: the fill and each photo batch wait on Chrome
  const panel = () => {
    const calls = [];
    const pending = [];
    const wait = (what, result) => new Promise((resolve) => pending.push({ what, done: () => resolve(result) }));
    const state = {
      origin: 'https://www.example-motors.test', vin: v.vin, step: 'filling', fbTabId: 77, map: FORM_MAP, settings: { basis: 'website' },
      listing: buildListingData(v, { dealer: DEALER, description, price: v.price, photos: ['https://img.example.test/1.jpg', 'https://img.example.test/2.jpg'] }),
      fill: null, photos: null,
    };
    const fns = compileMany(['runFill', 'attachPhotos', 'clearFlow', 'formTabShows', 'pageOf'], {
      state, flowRun: 0, watcher: null, FORM_MAP, VERSION: '0.0.0', onCreatePage, FORM_GONE_TEXT: 'gone',
      fillFormInPage: () => {}, attachPhotosInPage: () => {},
      chrome: {
        tabs: { get: async (id) => ({ id, url: FORM_MAP.createUrl }) },
        scripting: { executeScript: (opts) => { calls.push('executeScript ' + (opts.args[1] && opts.args[1].fields ? 'fill' : 'photos')); return wait('inject', [{ result: opts.args[1] && opts.args[1].fields ? { filled: [], partial: [], blocked: [], photoLimit: { value: 20, verified: true } } : { ok: true, attached: 1 } }]); } },
        runtime: { sendMessage: (msg) => { calls.push('download ' + msg.urls.length); return wait('download', { photos: msg.urls.map((url) => ({ ok: true, url, name: 'p.jpg', type: 'image/jpeg', dataUrl: 'data:' })) }); } },
        storage: { local: { remove: async () => {} } },
      },
      render: () => calls.push('render:' + state.step), saveFlow: async () => calls.push('saveFlow'), pilotNote: async () => {}, endPost: () => {}, noteFill: (p) => p, notePostStep: (p) => p,
      startWatcher: () => calls.push('startWatcher'), photoPatterns: () => [], refusedPhotoServers: new Set(), patternCovers: () => false, isFacebookServer: () => false,
      siteKeys: (o) => ({ flow: 'postFlow:' + o }),
    });
    return { state, calls, fns, pending, next: () => pending.shift().done() };
  };
  const filling = panel();
  const fill = filling.fns.runFill();
  await tick();
  await filling.fns.clearFlow();
  filling.next(); // the fill answers after the drop
  await fill;
  assert.deepEqual(filling.calls.filter((c) => !c.startsWith('render')), ['executeScript fill'], 'no publish step, watcher or photos for the dropped post');
  assert.deepEqual([filling.state.step, filling.state.fill], ['idle', null]);

  const photos = panel();
  photos.state.step = 'publish';
  photos.state.fill = { photoLimit: { value: 20, verified: true } };
  const attaching = photos.fns.attachPhotos();
  await tick();
  await photos.fns.clearFlow();
  photos.next(); // the download answers after the drop
  await attaching;
  assert.deepEqual(photos.calls.filter((c) => !c.startsWith('render')), ['download 2'], 'nothing attached after the drop');

  // generate, as written: the writer answers after the post was dropped and the next car's began
  const answer = deferred();
  const state = { origin: 'o', vin: 'BBB', vehicle: { ...v, vin: 'BBB' }, description: 'B text', settings: { rewrite: {}, dealer: DEALER, salesperson: {} }, highlights: null };
  const writing = compileMany(['generate', 'clearFlow'], {
    state, flowRun: 0, watcher: null, FORM_MAP, pilotNote: async () => {}, endPost: () => {}, siteKeys: (o) => ({ flow: 'f:' + o }),
    chrome: { storage: { local: { remove: async () => {} } } },
    rewriteWithKey: async (r) => r, vehicleForText: () => state.vehicle, noteFor: () => '',
    generateDescription: () => answer.promise, settleHighlights: () => [], LAPSED_MESSAGE: 'lapsed', LAPSED_SENTENCE: 'lapsed',
  });
  const text = writing.generate();
  await tick();
  await writing.clearFlow();
  Object.assign(state, { vin: 'CCC', description: 'C text', guardrails: 'C checks' });
  answer.resolve({ text: 'B written late', source: 'template', note: '', guardrails: 'B checks' });
  await text;
  assert.deepEqual([state.description, state.guardrails], ['C text', 'C checks'], 'the next car keeps its own text');
});

// Fill again, Fill it in now, Allow photos and each batch of photos act on
// a form opened earlier: they go to the tab the run began with, only while
// that tab still shows the form (formTabShows), and a batch that lands after
// It didn't post, Attach photos again or a new form for the car is dropped. The tab
// can be moved to another listing's edit form, and a late photo download must
// never reach another car's form. runFill, attachPhotos and formTabShows as
// written; Chrome's tabs, downloads and injections are stand-ins.
function formTabPanel({ photos = 6 } = {}) {
  const v = vehicle('usedNormal');
  const description = buildTemplateDescription({ vehicle: v, dealer: DEALER, salesperson: { name: 'Pat', title: 'sales consultant' } });
  const calls = [];
  const downloads = [];
  const tabs = { 77: FORM_MAP.createUrl, 88: FORM_MAP.createUrl };
  const urls = Array.from({ length: photos }, (_, i) => `https://img.example.test/${i + 1}.jpg`);
  const state = {
    origin: 'https://www.example-motors.test', vin: v.vin, step: 'publish', fbTabId: 77, map: FORM_MAP, settings: { basis: 'website' },
    listing: buildListingData(v, { dealer: DEALER, description, price: v.price, photos: urls }),
    fill: { url: FORM_MAP.createUrl, filled: [{ key: 'vin' }], partial: [], blocked: [], photoLimit: { value: 20, verified: true } }, photos: null, probe: null,
  };
  const fns = compileMany(['runFill', 'attachPhotos', 'formTabShows', 'pageOf'], {
    state, flowRun: 0, FORM_MAP, VERSION: '0.0.0', onCreatePage, FORM_GONE_TEXT: 'form gone',
    fillFormInPage: 'fill', attachPhotosInPage: 'photos',
    chrome: {
      tabs: { get: async (id) => { calls.push('tabs.get ' + id); if (!(id in tabs)) throw new Error('No tab with id: ' + id); return { id, url: tabs[id] }; } },
      scripting: {
        executeScript: async (opts) => {
          const what = opts.func === 'fill' ? 'fill' : `photos ${opts.args[1].map((f) => f.name).join(',')}`;
          calls.push(`inject ${opts.target.tabId}: ${what}`);
          return [{ result: opts.func === 'fill' ? { url: tabs[opts.target.tabId], filled: [{ key: 'vin' }], partial: [], blocked: [], photoLimit: { value: 20, verified: true } } : { ok: true, attached: opts.args[1].length } }];
        },
      },
      runtime: { sendMessage: (msg) => new Promise((resolve) => downloads.push(() => resolve({ photos: msg.urls.map((url) => ({ ok: true, url, name: url.split('/').pop(), type: 'image/jpeg', dataUrl: 'data:' })) }))) },
    },
    render: () => {}, saveFlow: async () => {}, pilotNote: async () => {}, noteFill: (p) => p, notePostStep: (p) => p,
    setStatus: (text, kind) => calls.push(`status${kind ? '(' + kind + ')' : ''}: ${text}`),
    startWatcher: () => calls.push('startWatcher'), photoPatterns: () => [], refusedPhotoServers: new Set(), patternCovers: () => false, isFacebookServer: () => false,
  });
  const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
  return { state, calls, fns, tabs, tick, pending: () => downloads.length, next: async () => { await tick(); downloads.shift()(); await tick(); } };
}

test('photos and later fills go only to this car\'s form, in the tab the run began with, while it still shows the form', async () => {
  const injected = (p) => p.calls.filter((c) => c.startsWith('inject'));

  // the person moves the form's tab to another listing's edit form between two batches
  const moved = formTabPanel();
  const a = moved.fns.attachPhotos();
  await moved.next();
  moved.tabs[77] = 'https://www.facebook.com/marketplace/edit/?listing_id=111';
  await moved.next();
  await a;
  assert.deepEqual(injected(moved), ['inject 77: photos 1.jpg,2.jpg,3.jpg,4.jpg'], 'nothing attached to the other listing');
  assert.match(moved.state.photos.error, /no longer shows this car's Marketplace form/);
  assert.equal(moved.state.photos.done, true);

  // It didn't post, then Open the Marketplace form again: the first run's late batch never reaches the new form
  const again = formTabPanel();
  const first = again.fns.attachPhotos();
  await again.next();
  Object.assign(again.state, { photos: null, fbTabId: 88 }); // notPosted, then a new tab for the car
  await again.next();
  await first; // no error thrown on the dropped photo count
  assert.deepEqual(injected(again), ['inject 77: photos 1.jpg,2.jpg,3.jpg,4.jpg'], 'the late batch is dropped, not attached to tab 88');
  assert.equal(again.state.photos, null);

  // Fill again (and Fill it in now) on a tab that shows something else: nothing typed
  const elsewhere = formTabPanel();
  elsewhere.tabs[77] = 'https://www.facebook.com/marketplace/item/111/';
  await elsewhere.fns.runFill();
  assert.deepEqual(injected(elsewhere), []);
  assert.ok(elsewhere.calls.includes('status(error): form gone'));
  delete elsewhere.tabs[77]; // closed, or an id from before Chrome restarted
  await elsewhere.fns.runFill();
  assert.deepEqual(injected(elsewhere), []);

  // on the form (the map's create page, or the page the fill found the form on): filled, into that tab
  const onForm = formTabPanel({ photos: 1 });
  const filling = onForm.fns.runFill();
  await onForm.next();
  await filling;
  assert.deepEqual(injected(onForm), ['inject 77: fill', 'inject 77: photos 1.jpg']);
  const rewritten = formTabPanel({ photos: 0 });
  rewritten.tabs[77] = 'https://www.facebook.com/marketplace/create/item?category=vehicles';
  rewritten.state.fill.url = 'https://www.facebook.com/marketplace/create/item?category=vehicles&step=1';
  await rewritten.fns.runFill();
  assert.deepEqual(injected(rewritten), ['inject 77: fill'], 'the page the fill found the form on counts as the form');

  // a form opened a moment ago for this car is filled as it loaded, with no check first
  const opened = formTabPanel({ photos: 0 });
  opened.tabs[77] = 'https://www.facebook.com/marketplace/create/item';
  await opened.fns.runFill({ opened: true });
  assert.deepEqual(opened.calls.filter((c) => c.startsWith('inject') || c.startsWith('tabs.get')), ['inject 77: fill']);
});

// Each change of the form's photo box adds to the photos already on it (the
// mock form does the same), so Fill again fills the fields only and leaves
// the photos sent earlier where they are; Attach photos again sends every
// photo once more, on the person's word, and the photos section then says
// each may be on the form twice. The form's own count stands in for the form.
test('Fill again leaves the photos on the form as they are; Attach photos again sends them all and says they may now be there twice', async () => {
  const p = formTabPanel({ photos: 2 });
  let onForm = 0;
  const injected = () => p.calls.filter((c) => c.startsWith('inject'));
  const count = () => { onForm = injected().filter((c) => c.includes('photos')).reduce((n, c) => n + c.split(' ').pop().split(',').length, 0); return onForm; };
  const first = p.fns.runFill({ opened: true });
  await p.next();
  await first;
  assert.deepEqual([count(), p.state.photos.attached, p.state.photos.done], [2, 2, true]);
  const sent = p.state.photos;

  // Fill again: the fields are filled again, no photo is sent, and the count still matches the form
  const refill = p.fns.runFill({ photos: false });
  await p.tick();
  if (p.pending()) await p.next(); // a photo download it started is answered, so its photos would reach the form
  await refill;
  assert.deepEqual(injected(), ['inject 77: fill', 'inject 77: photos 1.jpg,2.jpg', 'inject 77: fill']);
  assert.equal(count(), 2, 'the form still holds each photo once');
  assert.equal(p.state.photos, sent, 'the photo count on screen is the one for the photos on the form');
  assert.match(src, /case 'fillAgain': return runFill\(\{ photos: false \}\);/, 'the Fill again button fills the fields only');

  // Attach photos again: every photo is sent once more, and the panel says the form may hold two of each
  const again = p.fns.attachPhotos(null, { again: true });
  await p.next();
  await again;
  assert.equal(count(), 4);
  assert.deepEqual([p.state.photos.attached, p.state.photos.again], [2, true]);
  const photosHtml = compile('photosHtml', { state: p.state, blockedPatterns: () => [], esc: (x) => String(x), patternCovers: () => false, patternHost: (x) => x, allowButton: () => '' });
  assert.match(photosHtml(), /each is on it twice now: remove the extra copies on Facebook before you publish/);
  assert.match(src, /case 'attachAgain':\s*await askForPhotos\(\);\s*return state\.step === 'publish' \? attachPhotos\(null, \{ again: true \}\)/, 'the Attach photos again button sends them all again');

  // the first photos of a form (It didn't post, then a new form) are not "again", whatever the button
  const fresh = formTabPanel({ photos: 1 });
  const firstAgain = fresh.fns.attachPhotos(null, { again: true });
  await fresh.next();
  await firstAgain;
  assert.equal(fresh.state.photos.again, false);
  const kept = compile('photosHtml', { state: fresh.state, blockedPatterns: () => [], esc: (x) => String(x), patternCovers: () => false, patternHost: (x) => x, allowButton: () => '' })();
  assert.match(kept, /Fill again<\/b> fills the fields only and leaves these photos on the form/);
  assert.doesNotMatch(kept, /twice/);
});

// A post request (the popup's Post, its Continue in the side panel, the queue
// bar's Post next car) while car A's Marketplace form is open: A is never
// dropped. The request for A itself leaves the panel on A; one for another
// car is refused until the person says whether A posted.
function requestPanel({ step, vin = 'AAA', queueMode = false, queue = null }) {
  const calls = [];
  const FORM_STEPS = new Function(`return ${/const FORM_STEPS = (\[[^\]]*\]);/.exec(src)[1]}`)();
  const state = { origin: 'https://www.example-motors.test', vin, step, queueMode, queue, vehicle: vin ? { name: '2020 Make Model A' } : null, fbTabId: 55, snapshotVehicles: { BBB: { name: 'Car B' } } };
  const fns = compileMany(['formOpen', 'postRequested', 'resumeOpenForm', 'queueBar'], {
    state, FORM_STEPS, GLOBAL_KEYS: { postRequest: 'postRequest' },
    LIVE_STEPS, postUnderWay: () => Boolean(state.vin) && LIVE_STEPS.includes(state.step),
    saveFlow: async () => calls.push('saveFlow queueMode=' + state.queueMode),
    siteKeys: (o) => ({ flow: 'postFlow:' + o }),
    finishFirstText: new Function('state', 'nameOf', `return ${/const finishFirstText = ([^\n]+);\n/.exec(src)[1]}`)(state, (v) => v),
    chrome: { storage: { local: { remove: async (k) => calls.push('remove ' + k), get: async (k) => ({ [k]: state.saved }) } } },
    startFlow: async (req) => calls.push('startFlow ' + req.vin),
    resumeFlow: async (origin, flow) => {
      calls.push('resumeFlow ' + flow.vin);
      Object.assign(state, flow, { origin });
    },
    setStatus: (text, kind) => calls.push(`status${kind ? '(' + kind + ')' : ''}: ${text}`),
    render: () => calls.push('render'),
    currentVin: (q) => q.vins[q.index], describeQueue: () => 'Queue', esc: (s) => String(s), nameOf: (v) => v,
  });
  return { state, calls, fns };
}

test('a Post for another car never drops a Marketplace form that is open; the same car stays where it is', async () => {
  for (const step of ['filling', 'probe', 'publish']) {
    const other = requestPanel({ step });
    await other.fns.postRequested({ origin: other.state.origin, vin: 'BBB', dealerTabId: 9 });
    assert.ok(!other.calls.some((c) => c.startsWith('startFlow')), `${step}: car A is not dropped`);
    assert.ok(other.calls.includes('remove postRequest'), `${step}: the request is used up`);
    assert.ok(other.calls.includes('status(error): Finish or stop the current post (2020 Make Model A) first: its Marketplace form is open. Then click Post again.'), other.calls.join(' | '));
    assert.equal(other.state.vin, 'AAA');

    const same = requestPanel({ step, queueMode: true });
    await same.fns.postRequested({ origin: same.state.origin, vin: 'aaa', queue: true });
    assert.deepEqual(same.calls, ['remove postRequest', 'status: ', 'render'], `${step}: the same car's request leaves the panel on it`);
    // the same VIN on another website is another car
    const elsewhere = requestPanel({ step });
    await elsewhere.fns.postRequested({ origin: 'https://www.other-motors.test', vin: 'AAA' });
    assert.ok(elsewhere.calls.some((c) => c.startsWith('status(error): Finish or stop')));
  }
  // nothing on Facebook yet (nothing under way, a review, a stop): the new post starts, as before
  for (const step of ['idle', 'checking', 'review', 'blocked', 'done', 'queueDone']) {
    const p = requestPanel({ step });
    await p.fns.postRequested({ origin: p.state.origin, vin: 'BBB' });
    assert.deepEqual(p.calls, ['startFlow BBB'], step);
  }
  // the car under way itself, still being checked or reviewed (Continue in the side panel, a second click on Post): the post goes on, not started over
  for (const step of ['checking', 'review']) {
    const p = requestPanel({ step, queueMode: true });
    await p.fns.postRequested({ origin: p.state.origin, vin: 'aaa', queue: true });
    assert.deepEqual(p.calls, ['remove postRequest', 'status: ', 'render'], step);
    // a queue that starts with the car a single post is on takes that post into the queue
    const single = requestPanel({ step });
    await single.fns.postRequested({ origin: single.state.origin, vin: 'AAA', queue: true });
    assert.deepEqual(single.calls, ['remove postRequest', 'saveFlow queueMode=true', 'status: ', 'render'], `${step}, single post`);
    assert.equal(single.state.queueMode, true);
  }
  // a stopped or finished post of the same car starts again: it is read and checked afresh
  for (const step of ['blocked', 'done']) {
    const p = requestPanel({ step });
    await p.fns.postRequested({ origin: p.state.origin, vin: 'AAA' });
    assert.deepEqual(p.calls, ['startFlow AAA'], step);
  }
  const none = requestPanel({ step: 'idle', vin: null });
  await none.fns.postRequested({ origin: none.state.origin, vin: 'BBB' });
  assert.deepEqual(none.calls, ['startFlow BBB']);
});

test('a form left open when the panel closed comes back before a post request is handled, and the queue bar offers no Post next car over it', async () => {
  // the panel opens with car A waiting for Publish (saved) and a request for car B (Continue in the side panel)
  const p = requestPanel({ step: 'idle', vin: null });
  p.state.saved = { vin: 'AAA', step: 'publish', vehicle: { name: '2020 Make Model A' }, fbTabId: 55 };
  await p.fns.resumeOpenForm(p.state.origin);
  await p.fns.postRequested({ origin: p.state.origin, vin: 'BBB', queue: true });
  assert.equal(p.calls[0], 'resumeFlow AAA');
  assert.ok(!p.calls.some((c) => c.startsWith('startFlow')), 'A comes back and B waits');
  // a review saved with nothing on Facebook is not brought back: the request starts over it
  for (const step of ['review', 'checking', 'blocked', 'done', 'idle']) {
    const r = requestPanel({ step: 'idle', vin: null });
    r.state.saved = { vin: 'AAA', step };
    await r.fns.resumeOpenForm(r.state.origin);
    await r.fns.postRequested({ origin: r.state.origin, vin: 'BBB' });
    assert.deepEqual(r.calls, ['startFlow BBB'], step);
  }
  // a post of the very car the request is for, saved while it was checked or reviewed: it comes back, typed text and all, and the request leaves it there
  for (const step of ['checking', 'review']) {
    const r = requestPanel({ step: 'idle', vin: null });
    r.state.saved = { vin: 'AAA', step, vehicle: { name: '2020 Make Model A' }, description: 'typed by the person' };
    const req = { origin: r.state.origin, vin: 'aaa', queue: true };
    await r.fns.resumeOpenForm(r.state.origin, req);
    await r.fns.postRequested(req);
    assert.equal(r.calls[0], 'resumeFlow AAA', step);
    assert.ok(!r.calls.some((c) => c.startsWith('startFlow')), `${step}: not started over`);
    assert.equal(r.state.description, 'typed by the person');
  }
  for (const step of ['blocked', 'done']) {
    const r = requestPanel({ step: 'idle', vin: null });
    r.state.saved = { vin: 'AAA', step };
    const req = { origin: r.state.origin, vin: 'AAA' };
    await r.fns.resumeOpenForm(r.state.origin, req);
    await r.fns.postRequested(req);
    assert.deepEqual(r.calls, ['startFlow AAA'], step);
  }
  const nothing = requestPanel({ step: 'idle', vin: null });
  await nothing.fns.resumeOpenForm(undefined);
  assert.deepEqual(nothing.calls, []);

  // the queue bar: a single post's form open, so no Post next car
  const queue = { vins: ['BBB', 'CCC'], index: 0, status: 'running' };
  for (const step of ['filling', 'probe', 'publish']) assert.doesNotMatch(requestPanel({ step, queue }).fns.queueBar(), /queueNext/, step);
  assert.match(requestPanel({ step: 'review', queue }).fns.queueBar(), /id="queueNext"/);
  assert.match(requestPanel({ step: 'idle', vin: null, queue }).fns.queueBar(), /id="queueNext"/);
});

test('recording a post also writes it to the day\'s log the cap reads, and a full log write never stops the record', async () => {
  const run = async ({ logFails = false } = {}) => {
    const writes = [];
    const store = { 'posted:o': {}, 'postLog:o': [] };
    const state = { origin: 'o', vin: 'AAA', step: 'publish', vehicle: { vin: 'AAA', name: 'Car A', price: 20000 }, settings: { basis: 'website', salesperson: { name: 'Pat' } }, detected: null, queueMode: false, posted: {}, postLog: [], map: FORM_MAP };
    const confirmPosted = compile('confirmPosted', {
      state, $: () => null, watcher: null, flowRun: 0, confirmedRun: -1, listingLink,
      siteKeys: (o) => ({ posted: 'posted:' + o, postLog: 'postLog:' + o }),
      markPosted: (p, v, basis, at) => ({ ...p, [v.vin]: { name: v.name, price: v.price, postedAt: at } }),
      logPost: (log, vin, at) => [...log, { vin, at }],
      updateKey: async (key, change) => {
        if (logFails && key.startsWith('postLog')) throw new Error('QUOTA_BYTES quota exceeded');
        store[key] = change(store[key]);
        writes.push(key);
        return store[key];
      },
      panelStorage: {}, storageErrorText: (e) => String(e), setStatus: never('setStatus'),
      pilotNote: async () => {}, endPost: () => {}, accountsConfigured: () => false,
      afterQueueStep: never('afterQueueStep'), render: () => {}, saveFlow: async () => {},
    });
    await confirmPosted();
    return { state, store, writes };
  };
  const ok = await run();
  assert.deepEqual(ok.writes, ['posted:o', 'postLog:o']);
  assert.equal(ok.store['postLog:o'][0].vin, 'AAA');
  assert.equal(ok.store['postLog:o'][0].at, ok.store['posted:o'].AAA.postedAt, 'the same time as the posted entry, so an unmark finds it');
  assert.equal(ok.state.step, 'done');
  const full = await run({ logFails: true });
  assert.deepEqual(full.writes, ['posted:o']);
  assert.equal(full.state.step, 'done', 'the post is recorded all the same');
});

// A To do item handled after a post is over (recorded, or stopped with the
// reason) clears that post first, as Post another car or Back do: once the
// item is closed the Website menu switches websites again. Left in place, the
// old car kept the menu shut with no word why. A saved post that another
// window's side panel started since stays. Run with sidepanel.js's own
// openUpkeep, clearFlow, savedFlowIs and chooseSite.
test('a To do item after a finished or stopped post clears it, so the Website menu works once the item is closed', async () => {
  const A = 'https://www.example-motors.test';
  const B = 'https://www.example-trucks.test';
  const C = 'https://www.example-cars.test';
  const run = async ({ step, savedVin = 'AAA' }) => {
    const store = { ['postFlow:' + A]: { vin: savedVin, step } };
    const state = { origin: A, vin: 'AAA', step, vehicle: { vin: 'AAA', name: 'Car A' }, dealerTabId: 4, windowId: 3, map: FORM_MAP, listFilter: '' };
    const LIVE = ['checking', 'review', 'filling', 'probe', 'publish'];
    const upkeeps = [];
    const fns = compileMany(['openUpkeep', 'clearFlow', 'savedFlowIs', 'chooseSite'], {
      state, flowRun: 0, watcher: null, lastUpkeepAt: 0, listBusy: false, FORM_MAP, applyOverrides,
      GLOBAL_KEYS: { upkeepRequest: 'upkeepRequest', lastPostOrigin: 'lastPostOrigin', devOverrides: 'devOverrides' },
      siteKeys: (o) => ({ flow: 'postFlow:' + o }),
      chrome: { storage: { local: {
        get: async (k) => ({ [k]: store[k] }),
        set: async (o) => Object.assign(store, o),
        remove: async (k) => { for (const key of [].concat(k)) delete store[key]; },
      } } },
      postUnderWay: () => Boolean(state.vin) && LIVE.includes(state.step),
      endUpkeep: () => {}, startUpkeep: async (req) => upkeeps.push(req.vin), upkeepCtx: {}, loadSaved: async () => true,
      pilotNote: async () => {}, endPost: () => {}, setStatus: () => {}, render: () => {}, $: () => null,
    });
    await fns.openUpkeep({ origin: B, vin: 'ZZZ', kind: 'price', price: 19000, at: 1 });
    assert.deepEqual([upkeeps, state.step, state.origin], [['ZZZ'], 'upkeep', B], `${step}: the item opens`);
    state.step = 'idle'; // the item's Close (upkeepCtx.onClose)
    await fns.chooseSite(C);
    return { state, store };
  };
  for (const step of ['done', 'blocked']) {
    const r = await run({ step });
    assert.equal(r.state.vin, null, `${step}: the old car is gone`);
    assert.equal(r.state.origin, C, `${step}: the Website menu switched`);
    assert.equal(r.store['postFlow:' + A], undefined, `${step}: its saved post is cleared with it`);
  }
  // another window's panel saved its own post for that website since: it stays
  const other = await run({ step: 'done', savedVin: 'BBB' });
  assert.equal(other.state.origin, C);
  assert.deepEqual(other.store['postFlow:' + A], { vin: 'BBB', step: 'done' });
  // a post still under way is never dropped for a To do item
  const live = { origin: A, vin: 'AAA', step: 'publish', map: FORM_MAP };
  const said = [];
  const openUpkeep = compile('openUpkeep', {
    state: live, lastUpkeepAt: 0, GLOBAL_KEYS: { upkeepRequest: 'upkeepRequest' }, chrome: { storage: { local: { remove: async () => {} } } },
    postUnderWay: () => true, setStatus: (t) => said.push(t), clearFlow: never('clearFlow'), startUpkeep: never('startUpkeep'), endUpkeep: never('endUpkeep'),
  });
  await openUpkeep({ origin: B, vin: 'ZZZ', at: 2 });
  assert.deepEqual([live.vin, live.step, live.origin], ['AAA', 'publish', A]);
  assert.match(said.join(' '), /Finish or stop the current post/);
});

// The posted entry keeps the price the form was filled with. The dealer can
// switch the price basis in Settings while a form waits for Publish (or
// before a saved post comes back): working the price out again from the new
// basis would record a price the listing does not show, and every rescan
// would then find nothing to update. With the filled price recorded, the
// next rescan flags the gap. Run with sidepanel.js's own confirmPosted, the
// real markPosted and the real diffScans.
test('It\'s posted records the price the form was filled with, even when the price basis changed since, so the next rescan flags the gap', async () => {
  const car = { vin: 'AAA', name: 'Car A', price: 25000, priceBeforeFees: 24500 };
  const run = async ({ filledUnder, confirmUnder, price = basisPrice(car, filledUnder) }) => {
    const store = { 'posted:o': {}, 'postLog:o': [] };
    const state = { origin: 'o', vin: 'AAA', step: 'publish', vehicle: car, price, settings: { basis: filledUnder, salesperson: { name: 'Pat' } }, detected: null, queueMode: false, posted: {}, postLog: [], map: FORM_MAP };
    const confirmPosted = compile('confirmPosted', {
      state, $: () => null, watcher: null, flowRun: 0, confirmedRun: -1, listingLink, markPosted,
      siteKeys: (o) => ({ posted: 'posted:' + o, postLog: 'postLog:' + o }),
      logPost: (log, vin, at) => [...log, { vin, at }],
      updateKey: async (key, change) => (store[key] = change(store[key])),
      panelStorage: {}, storageErrorText: (e) => String(e), setStatus: never('setStatus'),
      pilotNote: async () => {}, endPost: () => {}, accountsConfigured: () => false,
      afterQueueStep: never('afterQueueStep'), render: () => {}, saveFlow: async () => {},
    });
    state.settings = { ...state.settings, basis: confirmUnder }; // Settings saved while the form waited (adoptChanges), or the post came back under new Settings
    await confirmPosted();
    const posted = store['posted:o'];
    const snap = { vehicles: { AAA: { ...car } } };
    return { recorded: posted.AAA.price, todo: diffScans(snap, snap, { posted, basis: confirmUnder }).priceUpdates };
  };
  // filled at the main price, then the dealer switched to the lower second price
  const down = await run({ filledUnder: 'website', confirmUnder: 'beforeFees' });
  assert.equal(down.recorded, 25000, 'the price the listing shows');
  assert.deepEqual(down.todo.map((t) => [t.from, t.to]), [[25000, 24500]], 'the next rescan asks for the update');
  // the other way round
  const up = await run({ filledUnder: 'beforeFees', confirmUnder: 'website' });
  assert.equal(up.recorded, 24500);
  assert.deepEqual(up.todo.map((t) => [t.from, t.to]), [[24500, 25000]]);
  // no switch: the same price as before, and nothing to do
  const same = await run({ filledUnder: 'beforeFees', confirmUnder: 'beforeFees' });
  assert.deepEqual([same.recorded, same.todo.length], [24500, 0]);
  // a post with no filled price kept (saved before prices were): the website's on today's basis, as before
  assert.equal((await run({ filledUnder: 'website', confirmUnder: 'beforeFees', price: null })).recorded, 24500);
});

// Only a listing's own address is kept as the listing link. Your listings,
// where Facebook often lands after Publish, would be opened by every To do
// item for the car (with no word that it is not the listing) and linked as the
// car's listing in the manager's view. Such an address is recorded as no link,
// the post is recorded all the same, and the panel says no link was saved.
// Run with sidepanel.js's own confirmPosted and the real listingLink and markPosted.
test('It\'s posted keeps a listing link only when it is a listing\'s own address; the post is recorded either way', async () => {
  const run = async ({ typed = '', detected = null, queueMode = false } = {}) => {
    const store = { 'posted:o': {}, 'postLog:o': [] };
    const said = [];
    const state = { origin: 'o', vin: 'AAA', step: 'publish', vehicle: { vin: 'AAA', name: 'Car A', price: 20000 }, settings: { basis: 'website', salesperson: { name: 'Pat' } }, detected, queueMode, posted: {}, postLog: [], map: FORM_MAP, snapshotVehicles: {} };
    const confirmPosted = compile('confirmPosted', {
      state, $: (id) => (id === 'listingUrl' ? { value: typed } : null), watcher: null, flowRun: 0, confirmedRun: -1, listingLink, markPosted,
      siteKeys: (o) => ({ posted: 'posted:' + o, postLog: 'postLog:' + o }),
      logPost: (log, vin, at) => [...log, { vin, at }],
      updateKey: async (key, change) => (store[key] = change(store[key])),
      panelStorage: {}, storageErrorText: (e) => String(e), setStatus: (text) => said.push(text),
      pilotNote: async () => {}, endPost: () => {}, accountsConfigured: () => false, nameOf: (vin) => (vin === 'AAA' ? 'Car A' : vin),
      afterQueueStep: async () => said.push('next car'), render: () => {}, saveFlow: async () => {}, savedFlowIs: async () => true,
    });
    await confirmPosted();
    return { entry: store['posted:o'].AAA, said, state };
  };
  const ITEM = 'https://www.facebook.com/marketplace/item/1234567890/';
  // the Your listings page, typed in or left in the box: recorded, with no link, and said so
  for (const typed of [FORM_MAP.yourListingsUrl, 'https://www.facebook.com/marketplace/selling/', 'https://www.facebook.com/', 'https://www.example-motors.test/used/car-1', 'not an address']) {
    const r = await run({ typed, detected: { status: 'probably', url: null, id: null } });
    assert.ok(r.entry && r.entry.postedAt, `${typed}: the post is recorded`);
    assert.equal(r.entry.listingUrl, undefined, `${typed}: no link`);
    assert.equal(r.state.step, 'done');
    assert.match(r.said.join(' '), /No listing link was saved for Car A/, `${typed}: the panel says so`);
  }
  // another address typed over the listing the tab showed is not swapped for it: no link rather than a guess
  const over = await run({ typed: FORM_MAP.yourListingsUrl, detected: { status: 'listing', url: ITEM, id: '1234567890' } });
  assert.equal(over.entry.listingUrl, undefined);
  // a queued car: recorded without a link, said so, and the queue moves on
  const queued = await run({ typed: FORM_MAP.yourListingsUrl, queueMode: true });
  assert.equal(queued.entry.listingUrl, undefined);
  assert.deepEqual(queued.said.map((t) => t.slice(0, 31)), ['No listing link was saved for C', 'next car']);
  // a listing's own address, in any of Facebook's spellings, is kept as its www address
  for (const [typed, kept] of [[ITEM, ITEM], [ITEM + '?ref=share', ITEM], ['https://m.facebook.com/marketplace/item/1234567890', 'https://www.facebook.com/marketplace/item/1234567890'], ['facebook.com/marketplace/item/1234567890/', ITEM]]) {
    const r = await run({ typed });
    assert.equal(r.entry.listingUrl, kept, typed);
    assert.deepEqual(r.said, [], `${typed}: nothing to say`);
  }
  // nothing typed: the listing the tab showed
  assert.equal((await run({ detected: { status: 'listing', url: ITEM, id: '1234567890' } })).entry.listingUrl, ITEM);
  assert.equal((await run({})).entry.listingUrl, undefined, 'nothing typed, nothing seen: no link, and nothing to say');
});

// A queued car is recorded once and moves the queue once. The listing
// watcher and a click on It's posted, next car (or a second click) can both
// arrive, and a side panel in another window holds the same car: the second
// confirm never records the next car, which was never posted, nor skips it,
// nor starts it a second time. Run with sidepanel.js's own confirmPosted,
// afterQueueStep and clearFlow on one shared store, the real queue, the real
// posted list and the real lock.
// queueMode false: a single post. detected: what this panel's watcher saw
// (null: nothing, a side panel in a second window, say). failQueueWrites:
// how many writes of the queue fail, as a full storage fails them.
// onUp: called once the next car is up. scope: stand-ins that replace the
// harness's own (slower pilot notes, say).
function queuePanel(store, { onNext = null, onUp = null, queueMode = true, detected = { status: 'listing', url: 'https://www.facebook.com/marketplace/item/1/' }, failQueueWrites = 0, scope = {} } = {}) {
  const O = 'https://www.example-motors.test';
  const calls = [];
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  let failing = failQueueWrites;
  const storage = {
    get: async (k) => { await tick(); return { [k]: store[k] }; },
    set: async (o) => {
      await tick();
      if (failing > 0 && Object.keys(o).some((k) => k.startsWith('postQueue'))) {
        failing -= 1;
        throw new Error('QUOTA_BYTES quota exceeded');
      }
      Object.assign(store, o);
    },
  };
  const state = {
    origin: O, vin: 'AAA', step: 'publish', queueMode, vehicle: { vin: 'AAA', name: 'Car A', price: 20000 }, price: 20000, settings: { basis: 'website', salesperson: { name: 'Pat' } },
    detected, queue: null, posted: {}, postLog: [], drafts: {}, map: FORM_MAP,
  };
  let fns;
  fns = compileMany(['confirmPosted', 'savedDraft', 'afterQueueStep', 'clearFlow', 'savedFlowIs'], {
    state, flowRun: 0, confirmedRun: -1, advancing: false, watcher: null, FORM_MAP, draftRecord, listingLink,
    $: () => null, updateKey, panelStorage: storage, markPosted, logPost, advance, currentVin,
    siteKeys: (o) => ({ posted: 'posted:' + o, postLog: 'postLog:' + o, queue: 'postQueue:' + o, flow: 'postFlow:' + o, drafts: 'drafts:' + o }),
    pilotNote: async () => { await tick(); }, endPost: () => {}, accountsConfigured: () => false,
    chrome: {
      storage: {
        local: {
          get: async (k) => { await tick(); return { [k]: store[k] }; },
          remove: async (k) => { await tick(); for (const key of [].concat(k)) delete store[key]; },
        },
      },
      runtime: { sendMessage: async () => {} },
    },
    storageErrorText: (e) => String(e), setStatus: (text) => calls.push('status: ' + text), render: () => calls.push('render:' + state.step), saveFlow: async () => {},
    nameOf: (vin) => vin,
    startNextInQueue: async () => {
      // the real startFlow: storage reads, clearFlow, then the next car comes up and is checked on the website
      calls.push('start ' + currentVin(state.queue));
      if (onNext) await onNext(fns, state);
      await tick();
      await fns.clearFlow();
      Object.assign(state, { vin: currentVin(state.queue), vehicle: null, step: 'checking', queueMode: true });
      if (onUp) onUp();
    },
    ...scope,
  });
  return { state, calls, fns };
}

test('a queued car is recorded once and moves the queue once, whether the watcher and a click both confirm it or a second window\'s panel does', async () => {
  const fresh = () => ({ 'postQueue:https://www.example-motors.test': { vins: ['AAA', 'BBB', 'CCC'], index: 0, status: 'running', results: {} } });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  const queueOf = (store) => store['postQueue:https://www.example-motors.test'];
  // the click lands while the next car is being brought up (the publish view is still on screen), or once it is being checked
  for (const when of ['before the next car', 'while the next car is checked']) {
    const store = fresh();
    let late = null;
    const p = queuePanel(store, {
      onNext: async (fns, state) => {
        if (when === 'before the next car') late = fns.confirmPosted();
        else setTimeout(() => { late = fns.confirmPosted(); }, 20);
        return state;
      },
    });
    await p.fns.confirmPosted(); // the watcher saw the listing address
    await settle();
    await late;
    assert.deepEqual([queueOf(store).index, queueOf(store).results], [1, { AAA: 'posted' }], `${when}: one step, A posted (${p.calls.join(' | ')})`);
    assert.deepEqual(Object.keys(store['posted:https://www.example-motors.test']), ['AAA'], `${when}: B is not recorded`);
    assert.equal(store['postLog:https://www.example-motors.test'].length, 1, `${when}: one post in the day's log`);
    assert.deepEqual(p.calls.filter((c) => c.startsWith('start')), ['start BBB'], `${when}: B is started once`);
    assert.deepEqual([p.state.vin, p.state.step], ['BBB', 'checking']);
  }

  // two panels (two windows) on the same car, both confirming it
  const store = fresh();
  const one = queuePanel(store);
  const two = queuePanel(store);
  await Promise.all([one.fns.confirmPosted(), two.fns.confirmPosted()]);
  await settle();
  assert.deepEqual([queueOf(store).index, queueOf(store).results], [1, { AAA: 'posted' }], `two panels: one step (${one.calls.join(' | ')} || ${two.calls.join(' | ')})`);
  const started = [...one.calls, ...two.calls].filter((c) => c.startsWith('start'));
  assert.deepEqual(started, ['start BBB'], 'B is started in one panel only');
  const behind = one.calls.includes('start BBB') ? two : one;
  assert.deepEqual([behind.state.vin, behind.state.step], [null, 'idle'], 'the other panel lets the car go');
  assert.ok(behind.calls.some((c) => /already moved on from AAA/.test(c)), 'and says so');

  // a confirm outside the publish step does nothing
  const idle = queuePanel(fresh());
  idle.state.step = 'review';
  await idle.fns.confirmPosted();
  assert.equal(idle.state.posted && Object.keys(idle.state.posted).length, 0);
});

// A side panel opened in a second Chrome window shows the same post with its
// buttons. Its It's posted, clicked after the first window's panel recorded
// the car (or after the popup's Mark posted), finds this person's entry
// already stored: the entry stays as it is, with the link it was recorded
// with (a link only this click knows is added), and the day's log and the
// cap count the post once. A colleague's entry for the car is not this
// person's post, so it is recorded over as before.
test('It\'s posted in a second window\'s side panel keeps the link and the count of a post already recorded', async () => {
  const O = 'https://www.example-motors.test';
  const ITEM = 'https://www.facebook.com/marketplace/item/555/';
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  for (const queueMode of [false, true]) {
    const what = queueMode ? 'queued car' : 'single post';
    const store = queueMode ? { ['postQueue:' + O]: { vins: ['AAA', 'BBB'], index: 0, status: 'running', results: {} } } : {};
    const one = queuePanel(store, { queueMode, detected: { status: 'listing', url: ITEM } });
    const two = queuePanel(store, { queueMode, detected: null }); // no watcher result in the second window
    await one.fns.confirmPosted();
    await settle();
    const first = { ...store['posted:' + O].AAA };
    assert.equal(first.listingUrl, ITEM, `${what}: the first window records the link`);
    await two.fns.confirmPosted();
    await settle();
    assert.deepEqual(store['posted:' + O].AAA, first, `${what}: the entry stays as the first window recorded it (${two.calls.join(' | ')})`);
    assert.equal(store['postLog:' + O].length, 1, `${what}: one post in the day's log`);
    assert.equal(two.state.posted.AAA.listingUrl, ITEM, `${what}: the second panel shows the recorded link`);
    if (queueMode) {
      assert.deepEqual([store['postQueue:' + O].index, store['postQueue:' + O].results], [1, { AAA: 'posted' }], `${what}: one step`);
      assert.deepEqual([two.state.vin, two.state.step], [null, 'idle']);
    } else {
      assert.deepEqual([two.state.step, two.state.doneAt], ['done', first.postedAt], `${what}: done, at the time it was recorded`);
    }
  }

  // recorded first without a link (the popup's Mark posted, or a panel that saw none): a later click that has one adds it
  const store = {};
  const bare = queuePanel(store, { queueMode: false, detected: null });
  await bare.fns.confirmPosted();
  const was = { ...store['posted:' + O].AAA };
  const withLink = queuePanel(store, { queueMode: false, detected: { status: 'listing', url: ITEM } });
  await withLink.fns.confirmPosted();
  assert.deepEqual(store['posted:' + O].AAA, { ...was, listingUrl: ITEM }, 'only the link is added');
  assert.equal(store['postLog:' + O].length, 1);

  // a colleague's entry for the car (synced in after the form opened): this person's post is recorded
  const shared = { ['posted:' + O]: { AAA: { name: 'Car A', price: 20000, postedAt: '2026-09-30T09:00:00.000Z', userId: 'u2', mine: false } } };
  const mine = queuePanel(shared, { queueMode: false, detected: { status: 'listing', url: ITEM } });
  await mine.fns.confirmPosted();
  assert.equal(shared['posted:' + O].AAA.mine, undefined, 'recorded as this person\'s');
  assert.equal(shared['posted:' + O].AAA.listingUrl, ITEM);
  assert.equal(shared['postLog:' + O].length, 1, 'and counted');
});

// The first window's panel recorded the car and went on (the queue's next car,
// or another single post) and saved that post, with its open form's tab.
// A late It's posted in the second window's panel, still showing the first
// car, leaves that saved post alone: closing and reopening the first
// window's panel brings its open form back instead of forgetting it.
test('a late It\'s posted in a second window\'s side panel never removes or overwrites the post the first window saved since', async () => {
  const O = 'https://www.example-motors.test';
  const ITEM = 'https://www.facebook.com/marketplace/item/555/';
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  for (const queueMode of [true, false]) {
    const what = queueMode ? 'queue' : 'single post';
    const store = queueMode ? { ['postQueue:' + O]: { vins: ['AAA', 'BBB'], index: 0, status: 'running', results: {} } } : {};
    const next = { vin: queueMode ? 'BBB' : 'CCC', step: 'publish', fbTabId: 88 };
    let two = null;
    const one = queuePanel(store, { queueMode, detected: { status: 'listing', url: ITEM }, onUp: () => { store['postFlow:' + O] = next; } });
    two = queuePanel(store, { queueMode, detected: { status: 'listing', url: ITEM }, scope: { saveFlow: async () => { store['postFlow:' + O] = { vin: two.state.vin, step: two.state.step }; } } });
    await one.fns.confirmPosted();
    await settle();
    if (!queueMode) store['postFlow:' + O] = next; // the first window's next post, its form open
    assert.deepEqual(store['postFlow:' + O], next, `${what}: the first window's next post is saved`);
    await two.fns.confirmPosted(); // the late click
    await settle();
    assert.deepEqual(store['postFlow:' + O], next, `${what}: still saved after the second window's click (${two.calls.join(' | ')})`);
    assert.equal(store['postLog:' + O].length, 1, `${what}: counted once`);
    if (queueMode) assert.deepEqual([store['postQueue:' + O].index, two.state.step], [1, 'idle']);
    else assert.equal(two.state.step, 'done');
  }

  // a single panel whose queue moved on without it (the popup skipped the car): its own saved post goes, as before
  const store = { ['postQueue:' + O]: { vins: ['AAA', 'BBB'], index: 1, status: 'running', results: { AAA: 'skipped' } }, ['postFlow:' + O]: { vin: 'AAA', step: 'publish', fbTabId: 77 } };
  const alone = queuePanel(store);
  await alone.fns.confirmPosted();
  await settle();
  assert.equal(store['postFlow:' + O], undefined, 'this car\'s own saved post is cleared');
  assert.deepEqual([alone.state.vin, alone.state.step], [null, 'idle']);
});

// A post recorded whose queue then could not be saved (a full storage):
// the panel says so and stays on the car, and It's posted, next car moves
// the queue when clicked again, without recording or counting the car twice.
test('It\'s posted, next car moves the queue when clicked again after the queue could not be saved', async () => {
  const O = 'https://www.example-motors.test';
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  const store = { ['postQueue:' + O]: { vins: ['AAA', 'BBB'], index: 0, status: 'running', results: {} } };
  const p = queuePanel(store, { failQueueWrites: 1 });
  await p.fns.confirmPosted();
  await settle();
  assert.deepEqual([store['postQueue:' + O].index, p.state.step], [0, 'publish'], 'the queue stays, the panel stays on the car');
  assert.ok(p.calls.some((c) => /quota/i.test(c)), 'and says why');
  await p.fns.confirmPosted();
  await settle();
  assert.deepEqual([store['postQueue:' + O].index, store['postQueue:' + O].results], [1, { AAA: 'posted' }], `the second click moves it (${p.calls.join(' | ')})`);
  assert.deepEqual(p.calls.filter((c) => c.startsWith('start')), ['start BBB']);
  assert.deepEqual(Object.keys(store['posted:' + O]), ['AAA']);
  assert.equal(store['postLog:' + O].length, 1, 'one post in the day\'s log');
});

// Saved as draft, next car records the car it was clicked for: a second
// click while the next car comes up records nothing against the next car
// and starts nothing twice.
test('Saved as draft, next car records one draft for its own car and moves the queue once', async () => {
  const O = 'https://www.example-motors.test';
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  for (const when of ['before the next car', 'before the next car, its work done after the next car is up', 'while the next car is checked']) {
    const store = { ['postQueue:' + O]: { vins: ['AAA', 'BBB', 'CCC'], index: 0, status: 'running', results: {} } };
    let late = null;
    let up;
    const nextUp = new Promise((resolve) => { up = resolve; });
    let draftNotes = 0;
    let clicked = false;
    const p = queuePanel(store, {
      onNext: async (fns) => {
        if (clicked) return; // one second click
        clicked = true;
        if (when.startsWith('before the next car')) late = fns.savedDraft();
        else setTimeout(() => { late = fns.savedDraft(); }, 20);
      },
      onUp: () => up(),
      // the second click's pilot note is slow: it ends after the next car is up
      // (the first click notes the draft twice: as it is saved, and as the queue moves)
      scope: when.includes('its work done') ? {
        endPost: (note, vin, outcome) => { note.outcome = outcome; },
        pilotNote: async (fn) => {
          const note = {};
          fn(note);
          await tick();
          if (note.outcome === 'draft' && ++draftNotes === 3) await nextUp;
        },
      } : {},
    });
    await p.fns.savedDraft();
    await settle();
    await late;
    assert.deepEqual([store['postQueue:' + O].index, store['postQueue:' + O].results], [1, { AAA: 'draft' }], `${when}: one step, A a draft (${p.calls.join(' | ')})`);
    assert.deepEqual(Object.keys(store['drafts:' + O]), ['AAA'], `${when}: no draft for B`);
    assert.deepEqual(p.calls.filter((c) => c.startsWith('start')), ['start BBB'], `${when}: B is started once`);
  }
});

// In a queue the panel records a post without asking only when the form's
// own tab went straight from the form to a listing not already recorded;
// any other listing address shows "Looks like it posted" and waits.
test('in a queue, only a new listing the form\'s tab moved to straight from the form is recorded without asking', async () => {
  const ITEM = 'https://www.facebook.com/marketplace/item/555/';
  const run = async ({ queueMode, result, posted = {}, windowId = null, panelWindowId = null }) => {
    const calls = [];
    const state = { step: 'publish', queueMode, fbTabId: 77, map: FORM_MAP, posted, detected: null, windowId };
    const { startWatcher } = compileMany(['startWatcher', 'postsWindow'], {
      state, watcher: null, isNewListingFromForm, panelWindowId,
      watchForListing: (opts) => {
        calls.push('watch ' + opts.createUrl);
        return { promise: Promise.resolve(result), cancel: () => {} };
      },
      confirmPosted: async () => calls.push('confirmPosted'),
      render: () => calls.push('render'), saveFlow: () => calls.push('saveFlow'),
    });
    startWatcher();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { calls, state };
  };
  const fromForm = { status: 'listing', url: ITEM, id: '555', afterCreate: true };
  const q = await run({ queueMode: true, result: fromForm });
  assert.deepEqual(q.calls, ['watch ' + FORM_MAP.createUrl, 'confirmPosted'], 'published from the form: recorded, next car');
  const own = await run({ queueMode: true, result: fromForm, windowId: 5, panelWindowId: 5 });
  assert.deepEqual(own.calls, ['watch ' + FORM_MAP.createUrl, 'confirmPosted'], 'the side panel of the window the post started in records it');
  // a side panel in a second window watches the same tab: it shows the
  // listing (so its It's posted keeps the link) but never records it by
  // itself, and leaves the saved post to the panel it belongs to
  const second = await run({ queueMode: true, result: fromForm, windowId: 5, panelWindowId: 9 });
  assert.deepEqual(second.calls, ['watch ' + FORM_MAP.createUrl, 'render'], `a second window: shown, not recorded, not saved (${second.calls.join(' | ')})`);
  assert.equal(second.state.detected, fromForm);
  for (const [what, opts] of [
    ['a listing browsed to', { queueMode: true, result: { ...fromForm, url: 'https://www.facebook.com/marketplace/item/987654321/', id: '987654321', afterCreate: false } }],
    ['a listing the tab already showed', { queueMode: true, result: { ...fromForm, afterCreate: false } }],
    ['a listing already recorded', { queueMode: true, result: fromForm, posted: { OTHER: { listingUrl: ITEM } } }],
    ['a single post', { queueMode: false, result: fromForm }],
  ]) {
    const r = await run(opts);
    assert.ok(!r.calls.includes('confirmPosted'), `${what}: not recorded without the person (${r.calls.join(' | ')})`);
    assert.equal(r.state.detected, opts.result, `${what}: shown as "Looks like it posted"`);
    assert.ok(r.calls.includes('render') && r.calls.includes('saveFlow'));
  }
});

// A side panel opened in a second window brings back the same post at
// Publish. Every panel on it watches its tab, so a click on It's posted in
// any of them knows the listing's link; only the panel of the window the
// post belongs to records it by itself (startWatcher, the test above).
test('a post brought back at Publish is watched by the side panel of every window it shows in', async () => {
  const v = vehicle('usedNormal');
  const description = buildTemplateDescription({ vehicle: v, dealer: DEALER, salesperson: { name: 'Pat', title: 'sales consultant' } });
  for (const [windowId, panelWindowId] of [[5, 5], [5, 9], [null, 9], [5, null]]) {
    const o = formOpener({ description, step: 'idle', extra: { panelWindowId } });
    await o.fns.resumeFlow(o.state.origin, { vin: v.vin, step: 'publish', vehicle: v, price: v.price, description, fbTabId: 77, windowId });
    assert.ok(o.calls.includes('startWatcher'), `post from window ${windowId}, panel in window ${panelWindowId}`);
    assert.equal(o.state.step, 'publish');
  }
  const none = formOpener({ description, step: 'idle', extra: { panelWindowId: 5 } });
  await none.fns.resumeFlow(none.state.origin, { vin: v.vin, step: 'review', vehicle: v, price: v.price, description, windowId: 5 });
  assert.ok(!none.calls.includes('startWatcher'), 'no form yet: nothing to watch');
});

// Saved as draft, next car: the draft keeps the price the form was filled
// with, so the popup's Mark posted later records that price, not the
// website's of that day (src/drafts.js).
test('a car saved as a Facebook draft is kept with the price its form was filled with', async () => {
  for (const basis of ['website', 'beforeFees']) {
    const v = vehicle('usedNormal');
    const filled = basisPrice(v, basis);
    const store = { 'drafts:o': { OTHER: { name: 'Other car', savedAt: '2026-09-30T10:00:00Z' } } };
    const calls = [];
    const state = { origin: 'o', vin: v.vin, step: 'publish', vehicle: v, price: filled, settings: { basis }, drafts: {} };
    const savedDraft = compile('savedDraft', {
      state, draftRecord, panelStorage: {}, flowRun: 0, confirmedRun: -1,
      siteKeys: (o) => ({ drafts: 'drafts:' + o }),
      updateKey: async (key, change) => (store[key] = change(store[key])),
      storageErrorText: (e) => String(e), setStatus: never('setStatus'),
      pilotNote: async () => calls.push('pilotNote'), endPost: () => {},
      afterQueueStep: async (outcome) => calls.push('afterQueueStep ' + outcome),
    });
    await savedDraft();
    const record = store['drafts:o'][v.vin];
    assert.deepEqual([record.name, record.price, record.basis], [v.name, filled, basis], basis);
    assert.ok(!Number.isNaN(Date.parse(record.savedAt)));
    assert.ok(store['drafts:o'].OTHER, 'the other drafts stay');
    assert.equal(state.drafts, store['drafts:o']);
    assert.deepEqual(calls, ['pilotNote', 'afterQueueStep draft']);
  }
});

// The queue bar's Stop queue and Clear queue, as onClick runs them: the queue
// goes, and so does a queued car with nothing on Facebook yet, but a post whose
// Marketplace form is open, or one that is not the queue's, stays where it is.
function queueBarClick(id, { step, queueMode, vin = 'AAA' }) {
  const calls = [];
  const FORM_STEPS = new Function(`return ${/const FORM_STEPS = (\[[^\]]*\]);/.exec(src)[1]}`)();
  const state = { origin: 'https://www.example-motors.test', vin, step, queueMode, queue: { vins: ['AAA', 'BBB'], index: 0, status: id === 'queueClear' ? 'done' : 'running' } };
  const fns = compileMany(['formOpen', 'onClick'], {
    state, FORM_STEPS, promptOpen: false,
    watcher: { cancel: () => calls.push('watcher cancelled') },
    saveQueue: async () => calls.push('saveQueue ' + JSON.stringify(state.queue)),
    clearFlow: async () => {
      calls.push('clearFlow');
      Object.assign(state, { vin: null, step: 'idle', queueMode: false });
    },
    saveFlow: async () => calls.push('saveFlow'),
    setStatus: (text, kind) => calls.push(`status${kind ? '(' + kind + ')' : ''}: ${text}`),
    render: () => calls.push('render:' + state.step),
  });
  return { state, calls, click: () => fns.onClick({ target: { closest: () => ({ id, dataset: {} }) } }) };
}

test('Stop queue and Clear queue never drop a Marketplace form that is open, nor a post that is not the queue\'s', async () => {
  for (const id of ['queueStop', 'queueClear']) {
    // a form is open (a queued car's, or a single post's): it stays, and a queued car goes on as a single post
    for (const queueMode of [true, false]) {
      for (const step of ['filling', 'probe', 'publish']) {
        const p = queueBarClick(id, { step, queueMode });
        await p.click();
        const what = `${id}, ${queueMode ? 'queued' : 'single'} car at ${step}`;
        assert.equal(p.state.queue, null, `${what}: the queue goes`);
        assert.ok(!p.calls.includes('clearFlow') && !p.calls.includes('watcher cancelled'), `${what}: ${p.calls.join(' | ')}`);
        assert.deepEqual([p.state.vin, p.state.step, p.state.queueMode], ['AAA', step, false], what);
        assert.ok(p.calls.includes('saveFlow'), `${what}: saved as a single post`);
      }
    }
    // a single post with nothing on Facebook yet is not the queue's either: it stays
    for (const step of ['checking', 'review', 'blocked', 'done']) {
      const p = queueBarClick(id, { step, queueMode: false });
      await p.click();
      assert.deepEqual([p.state.queue, p.state.vin, p.state.step], [null, 'AAA', step], `${id}, single post at ${step}`);
      assert.ok(!p.calls.includes('clearFlow'));
    }
    // a queued car with nothing on Facebook yet, or no post at all: cleared, as before
    for (const step of ['checking', 'review', 'blocked']) {
      const p = queueBarClick(id, { step, queueMode: true });
      await p.click();
      assert.ok(p.calls.includes('clearFlow'), `${id}, queued car at ${step}`);
      assert.deepEqual([p.state.queue, p.state.vin, p.state.step], [null, null, 'idle']);
    }
    const none = queueBarClick(id, { step: 'queueDone', queueMode: false, vin: null });
    await none.click();
    assert.deepEqual([none.state.queue, none.state.step], [null, 'idle']);
  }
});

// The review screen's buttons follow the description's checks: drawn off
// (viewReview) and switched off or on as the person types (onInput, through
// setFormButtons) while a posting rule is broken, and off at the day's cap.
test('Open the Marketplace form and Check fields are off while the description breaks a posting rule or the cap is reached, and on again once it is fixed', () => {
  const v = vehicle('usedNormal');
  const good = buildTemplateDescription({ vehicle: v, dealer: DEALER, salesperson: { name: 'Pat', title: 'sales consultant' } });
  const bad = good.replaceAll(DEALER.name, 'the lot');
  const check = (text) => runGuardrails(text, { vehicle: v, dealer: DEALER, price: v.price });
  let cap = { reached: false, used: 0, cap: 10 };
  const buttons = { openForm: { disabled: false }, checkForm: { disabled: false } };
  const state = { vehicle: v, price: v.price, description: good, guardrails: check(good), note: '', descriptionSource: 'template', settings: { dealer: DEALER, rewrite: { enabled: false } } };
  const blank = () => '';
  const fns = compileMany(['viewReview', 'setFormButtons', 'onInput'], {
    state, ruleProblems, runGuardrails, dailyCap: () => cap, inputTimer: null,
    ctx: () => ({ vehicle: state.vehicle, dealer: DEALER, priceNote: '', price: state.price, closingLine: '' }),
    setTimeout: (fn) => fn(), clearTimeout: () => {}, saveFlow: () => {}, renderList: never('renderList'),
    $: (id) => buttons[id] || null, esc: (s) => String(s ?? ''),
    carCard: blank, readAgainHtml: blank, sourcePill: blank, checksHtml: blank, highlightsHtml: blank, photoPickHtml: blank,
    fieldsTable: blank, vinCheckHtml: blank, assumptionsHtml: blank, capHtml: blank, photoServersHtml: blank,
  });
  const drawnOff = () => ['openForm', 'checkForm'].map((id) => new RegExp(`id="${id}" disabled`).test(fns.viewReview()));
  assert.deepEqual(drawnOff(), [false, false], 'a description that passes: both on');
  state.guardrails = check(bad);
  assert.deepEqual(drawnOff(), [true, true], 'the dealership not named: both drawn off');
  state.guardrails = check(good);
  cap = { reached: true, used: 10, cap: 10 };
  assert.deepEqual(drawnOff(), [true, true], 'at the cap: both drawn off');
  cap = { reached: false, used: 0, cap: 10 };

  // typing: the buttons follow the text in the box
  fns.onInput({ target: { id: 'description', value: bad } });
  assert.deepEqual([buttons.openForm.disabled, buttons.checkForm.disabled], [true, true], 'off as the rule breaks');
  assert.equal(state.descriptionSource, 'edited');
  fns.onInput({ target: { id: 'description', value: good + '\nAsk about the 2 keys.' } });
  assert.deepEqual([buttons.openForm.disabled, buttons.checkForm.disabled], [true, true], 'an unsourced number keeps them off');
  fns.onInput({ target: { id: 'description', value: good } });
  assert.deepEqual([buttons.openForm.disabled, buttons.checkForm.disabled], [false, false], 'on again once fixed');
  fns.onInput({ target: { id: 'description', value: `Pre-owned at ${DEALER.name}. VIN ${v.vin}.` } });
  assert.deepEqual([buttons.openForm.disabled, buttons.checkForm.disabled], [false, false], 'a style warning (too short) leaves them on');
});

// A scan that lands after the car was read and no longer lists it (the
// worker's rescan, the popup's Scan, a colleague's sale) contradicts the read
// even inside READ_MAX_AGE_MS: Open the Marketplace form and Fill it in now
// read the car again first, and the read decides. A scan that still lists
// it, or one older than the read, changes nothing.
test('a scan since the read that no longer lists the car has it read again before the form opens or fills', async () => {
  const v = vehicle('usedNormal');
  const description = buildTemplateDescription({ vehicle: v, dealer: DEALER, salesperson: { name: 'Pat', title: 'sales consultant' } });
  const minuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const gone = async () => ({ ok: false, notFound: true, message: "This car isn't on the website any more." });
  const opened = (calls) => calls.filter((c) => c === 'tabs.create' || c.startsWith('runFill') || c === 'runProbe');
  for (const step of ['review', 'probe']) {
    const o = formOpener({ description, step, readAt: minuteAgo, read: gone });
    Object.assign(o.state, { snapshotTakenAt: now, snapshotVehicles: { OTHERVIN0000000001: { name: 'another car' } } });
    if (step === 'review') await o.fns.openForm();
    else await o.fns.fillFromProbe();
    assert.deepEqual(opened(o.calls), [], `${step}: nothing opened or filled`);
    assert.ok(o.calls.includes(`readCarForPost ${v.vin} tab 41`), `${step}: read again`);
    assert.ok(o.calls.includes('block: not-on-website'), `${step}: ${o.calls.join(' | ')}`);
  }
  // the scan still lists the car as it was read, or it is older than the read: no read
  for (const [what, snapshotTakenAt, listed] of [['still listed', now, true], ['an older scan', new Date(Date.now() - 3600 * 1000).toISOString(), false], ['no scan time', null, false]]) {
    const o = formOpener({ description, readAt: minuteAgo });
    Object.assign(o.state, { snapshotTakenAt, snapshotVehicles: listed ? { [v.vin]: snapshotEntry(v, assessVehicle(v, {})) } : {} });
    await o.fns.openForm();
    assert.deepEqual(opened(o.calls), ['tabs.create', `runFill: ${description}`], what);
  }
  // the newer scan lists the car at another price, status or type: read again, and the read decides
  const changes = [
    ['a lower price', { price: v.price - 1000 }],
    ['another second price', { priceBeforeFees: (v.priceBeforeFees || v.price) - 500 }],
    ['sale pending', { status: 'pend-sale' }],
    ['in transit', { availability: 'In-Transit' }],
    ['retyped new', { type: 'New' }],
  ];
  for (const [what, change] of changes) {
    const o = formOpener({ description, readAt: minuteAgo, read: gone });
    Object.assign(o.state, { snapshotTakenAt: now, snapshotVehicles: { [v.vin]: { ...snapshotEntry(v, assessVehicle(v, {})), ...change } } });
    await o.fns.openForm();
    assert.deepEqual(opened(o.calls), [], `${what}: nothing opened`);
    assert.ok(o.calls.includes(`readCarForPost ${v.vin} tab 41`), `${what}: read again`);
  }
});

// A single post at review can be dropped there (the person would otherwise
// have to post it, or post another car, before a To do item opens). A queued
// car has Skip this car on the queue bar instead.
test('Stop this post on the review screen drops a single post; a queued car has no such button', async () => {
  const v = vehicle('usedNormal');
  const blank = () => '';
  const state = { step: 'review', vin: v.vin, vehicle: v, price: v.price, description: 'x', guardrails: { ok: true, problems: [] }, note: '', descriptionSource: 'template', settings: { dealer: DEALER, rewrite: { enabled: false } }, queueMode: false };
  const calls = [];
  const fns = compileMany(['viewReview', 'onClick'], {
    state, ruleProblems: () => [], dailyCap: () => ({ reached: false, used: 0, cap: 10 }), esc: (s) => String(s ?? ''),
    carCard: blank, readAgainHtml: blank, sourcePill: blank, checksHtml: blank, highlightsHtml: blank, photoPickHtml: blank,
    fieldsTable: blank, vinCheckHtml: blank, assumptionsHtml: blank, capHtml: blank, photoServersHtml: blank,
    promptOpen: false, nameOf: (vin) => vin,
    clearFlow: async () => { calls.push('clearFlow'); Object.assign(state, { step: 'idle', vin: null, vehicle: null }); },
    setStatus: (text) => calls.push('status: ' + text), render: () => calls.push('render:' + state.step),
  });
  assert.match(fns.viewReview(), /<button type="button" class="plain wide" id="stopPost">Stop this post<\/button>/);
  const click = (id) => fns.onClick({ target: { closest: () => ({ id, dataset: {} }) } });
  state.queueMode = true;
  assert.doesNotMatch(fns.viewReview(), /id="stopPost"/, 'a queued car: Skip this car on the queue bar instead');
  await click('stopPost');
  assert.deepEqual(calls, [], 'a queued car is not dropped this way');
  state.queueMode = false;
  state.step = 'publish';
  await click('stopPost');
  assert.deepEqual(calls, [], 'never once a form is open');
  state.step = 'review';
  await click('stopPost');
  assert.deepEqual(calls, ['clearFlow', `status: Stopped the post of ${v.name}. Click Post on any car to start again.`, 'render:idle']);
});
