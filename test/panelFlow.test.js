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
//     review with a notice (posting rule 3), and a queue waits there;
//   - no post starts before the posting rules are ticked for the website.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { currentVin, advance } from '../extension/src/queue.js';
import { markPosted, diffScans } from '../extension/src/rescan.js';
import { logPost, capStatus, capCount } from '../extension/src/cap.js';
import { updateKey } from '../extension/src/storage.js';
import { runGuardrails, ruleProblems, buildTemplateDescription } from '../extension/src/rewriteTemplate.js';
import { buildListingData, listingChanges } from '../extension/src/listingData.js';
import { recheck } from '../extension/src/vehicleDetails.js';
import { basisPrice, snapshotEntry } from '../extension/src/rescan.js';
import { assessVehicle } from '../extension/src/classify.js';
import { draftRecord } from '../extension/src/drafts.js';
import { shortLocation, storeNames } from '../extension/src/normalize.js';
import { localVinCheck } from '../extension/src/vin.js';
import { FORM_MAP, applyOverrides } from '../extension/facebook/formMap.js';
import { isNewListingFromForm, showsPostedCar, onCreatePage, listingLink } from '../extension/facebook/detectPost.js';
import { namesakesOf } from '../extension/upkeep.js';
import { vehicle } from './helpers.js';
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
// A top-level one-line const as written (such as dealerNamed or NO_DEALER_TEXT).
function constText(name) {
  const m = src.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  assert.ok(m, `${name} is defined`);
  return m[0];
}
// The description stop every opening and fill goes through (fillBlocker), with
// the two consts it reads, as sidepanel.js writes them: compiled into a scope
// that has state, runGuardrails, ruleProblems and ctx.
const BLOCKER_CONSTS = ['dealerNamed', 'NO_DEALER_TEXT'];
// Several functions compiled in one scope, so they call each other as written;
// consts: top-level one-line consts compiled in with them.
function compileMany(names, scope, consts = []) {
  const keys = Object.keys(scope);
  return new Function(...keys, `${consts.map(constText).join('\n')}\n${names.map(fnText).join('\n')}\nreturn { ${names.join(', ')} };`)(...keys.map((k) => scope[k]));
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
    const fns = compileMany(['startNextInQueue', 'startWatcher', 'postsWindow', 'confirmIfThisCar'], {
      state, currentVin, panelWindowId, isNewListingFromForm, watcher: null,
      // the new listing's page shows this car (its VIN)
      flowRun: 0, sleep: async () => {}, basisPrice: () => 20000, namesakesOf, showsPostedCar, readListingInPage: 'readListingInPage', LISTING_SIGNS: {}, VERIFY_READS: 6, VERIFY_EVERY_MS: 0,
      chrome: { scripting: { executeScript: async () => [{ result: { matchesId: true, vinInText: true, formOnPage: false } }] } },
      dailyCap: () => ({ reached: false }), pauseQueue: never('pauseQueue'), saveQueue: never('saveQueue'), clearFlow: never('clearFlow'), setStatus: never('setStatus'), capCount: () => '',
      // startFlow as far as the form: it takes the request's window, then openForm and runFill start the watcher
      startFlow: async (req) => {
        calls.push(`start ${req.vin}`);
        Object.assign(state, { vin: req.vin, windowId: req.windowId || null, queueMode: true, step: 'publish', detected: null, vehicle: { vin: req.vin, name: 'Car B' }, price: 20000, settings: { basis: 'website' } });
      },
      watchForListing: () => ({ promise: Promise.resolve({ status: 'listing', url: ITEM, id: '556', afterCreate: true }), cancel: () => {} }),
      confirmPosted: async () => calls.push('confirmPosted'), render: () => calls.push('render'), saveFlow: () => calls.push('saveFlow'),
    });
    await fns.startNextInQueue();
    fns.startWatcher();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, ['start BBB', 'render', 'confirmPosted'], `queue made in window ${made}, walked in window ${panelWindowId}: B is recorded by itself (${calls.join(' | ')})`);
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
function startFlowWith({ posted, queue, rulesReadAt = '2026-09-30T12:00:00.000Z' }) {
  const calls = [];
  const state = { origin: 'https://www.example-dealer.test', posted, settings: { rulesReadAt }, snapshotVehicles: { AAA: { name: '2020 Make Model' } } };
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
  return { calls, state, run: () => startFlow({ origin: state.origin, vin: 'aaa', dealerTabId: null, queue }) };
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
    carCard: blank, readAgainHtml: blank, languageHint: blank, photoServersHtml: blank, fillBlocker: blank,
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

// startFlow from the request to review, every step past the posted check
// stubbed to pass; canAutoOpen is the panel's own, so a queue opens the form
// unless something holds the car at review.
async function reviewWith(takenDown, { queue = true } = {}) {
  const calls = [];
  const state = {
    origin: 'https://www.example-dealer.test', posted: {}, takenDown,
    snapshotVehicles: { AAA: { name: '2020 Make Model' } },
    settings: { salesperson: { name: 'Sam' }, basis: 'website', rulesReadAt: '2026-09-30T12:00:00.000Z' },
  };
  const canAutoOpen = compile('canAutoOpen', {
    state, currentListing: () => ({ missing: [], assumed: [] }), dailyCap: () => ({ reached: false }), photoPatterns: () => [], refusedPhotoServers: new Set(),
  });
  const { startFlow } = compileMany(['startFlow', 'readCarNow', 'takeCar'], {
    state,
    chrome: { storage: { local: { remove: async () => {} } } },
    GLOBAL_KEYS: { postRequest: 'postRequest' },
    flowRun: 0,
    endUpkeep: () => {}, clearFlow: async () => 0, loadSaved: async () => true, refreshGranted: async () => {},
    nameOf: (vin) => state.snapshotVehicles[vin].name,
    afterQueueStep: never('afterQueueStep'), block: never('block'), stopPosted: never('stopPosted'),
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

// The posting rules come before the first post from a website: a person who
// skipped set-up (Not now on the popup's banner) ticks them in the panel.
test('no post starts before the posting rules are ticked: the panel shows them, and the tick starts the same post again', async () => {
  for (const queue of [false, true]) {
    const r = startFlowWith({ posted: {}, queue, rulesReadAt: '' });
    await r.run();
    assert.equal(r.state.step, 'rules', 'stopped at the rules, before the website is read or an attempt is begun');
    assert.equal(r.state.vin, 'AAA');
    assert.deepEqual(r.calls, ['clearFlow', 'status:', 'render']);
  }

  const rules = compile('viewRules', { POSTING_RULES, esc: (x) => String(x) })();
  for (const rule of POSTING_RULES) assert.ok(rules.includes(rule.title) && rules.includes(rule.text), `the panel shows "${rule.title}"`);
  assert.match(rules, /<input type="checkbox" id="rulesRead" \/> I have read the posting rules and will follow them/);
  assert.match(rules, /id="rulesContinue" disabled>Continue to the post/, 'nothing goes on until the tick');

  // the tick: saved in the website's settings, then the same request again
  const state = { origin: 'https://www.example-dealer.test', vin: 'AAA', dealerTabId: 7, windowId: 3, queueMode: true, settings: { dailyCap: 10, rulesReadAt: '' } };
  const writes = [];
  const restarted = [];
  let ticked = false;
  const acceptRules = compile('acceptRules', {
    state, $: () => ({ checked: ticked }), siteKeys: (o) => ({ settings: 'settings:' + o }), panelStorage: {},
    updateKey: async (key, change) => { const next = change({ dailyCap: 8 }); writes.push([key, next]); return next; },
    setStatus: never('setStatus'), storageErrorText: String,
    startFlow: async (req) => restarted.push(req),
  });
  await acceptRules();
  assert.deepEqual([writes, restarted], [[], []], 'without the tick nothing is saved or started');
  ticked = true;
  await acceptRules();
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'settings:https://www.example-dealer.test');
  assert.equal(writes[0][1].dailyCap, 8, 'the stored settings are kept, the tick added');
  assert.ok(Date.parse(writes[0][1].rulesReadAt) > 0);
  assert.equal(state.settings.rulesReadAt, writes[0][1].rulesReadAt);
  assert.deepEqual(restarted, [{ origin: state.origin, vin: 'AAA', dealerTabId: 7, windowId: 3, queue: true }]);

  // Not now: nothing posted; a queue is paused, not skipped through
  const left = { queue: { vins: ['AAA'], index: 0, status: 'running' }, queueMode: true };
  const said = [];
  const leaveRules = compile('leaveRules', {
    state: left, pauseQueue: (q) => ({ ...q, status: 'paused' }), saveQueue: async () => said.push('saved'),
    clearFlow: async () => said.push('cleared'), setStatus: (t) => said.push(t), render: () => said.push('render'),
  });
  await leaveRules();
  assert.equal(left.queue.status, 'paused');
  assert.deepEqual(said, ['saved', 'cleared', 'Nothing was posted: the posting rules come first. The queue is paused; Resume shows the rules again.', 'render']);
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
    description, settings: { dealer: DEALER, defaults: {}, basis: 'website', priceNote: '', salesperson: { name: 'Pat', title: 'sales consultant', closingLine: '' }, dailyCap: 10, rulesReadAt: '2026-09-30T12:00:00.000Z' },
    posted: {}, colorGuess: null, listing: null, snapshotVehicles: {}, siteInfo: null, dealerTabId: 41, map: FORM_MAP, photoPick: null,
  };
  const ctx = () => ({ vehicle: state.vehicle, dealer: state.settings.dealer, salesperson: state.settings.salesperson, priceNote: '', price: state.price, closingLine: '' });
  // the dry run built the listing when it opened the form
  if (step === 'probe') state.listing = buildListingData(v, { dealer: DEALER, description, price: v.price, photos: [] });
  const fns = compileMany(['resumeFlow', 'descriptionStopped', 'fillBlocker', 'readIsOld', 'readCarNow', 'takeCar', 'formValues', 'carStillCurrent', 'readStoredCounts', 'openForm', 'fillFromProbe', ...also], {
    state, ctx, runGuardrails, ruleProblems, buildListingData, listingChanges, READ_MAX_AGE_MS, FLOW_FIELDS, flowRun: 0,
    FORM_STEPS: new Function(`return ${/const FORM_STEPS = (\[[^\]]*\]);/.exec(src)[1]}`)(),
    watcher: null, endPost: () => {}, beginPost: () => {}, endUpkeep: () => {}, refreshGranted: async () => {}, nameOf: (vin) => vin,
    afterQueueStep: async (outcome) => calls.push('afterQueueStep ' + outcome), canAutoOpen: () => autoOpen, maybeGuessColors: async () => {},
    generate: async () => {
      calls.push(`generate ${state.vin} with ${state.vehicle.vin}`);
      if (gen) return gen(state);
      state.description = `Sales consultant at ${DEALER.name}. VIN ${state.vehicle.vin}.`;
      return undefined;
    },
    LIVE_STEPS, postUnderWay: () => Boolean(state.vin) && LIVE_STEPS.includes(state.step),
    finishFirstText: (button) => `Finish or stop the current post first. Then click ${button} again.`,
    loadSaved: async () => true, startWatcher: () => calls.push('startWatcher'),
    recheck, basisPrice, shortLocation, storeNames, localVinCheck, relistNotice, money: (n) => '$' + n.toLocaleString('en-US'),
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
  }, BLOCKER_CONSTS);
  return { state, calls, fns, v, forms, box };
}

test('a description that breaks a posting rule is never typed into the form; a style warning alone does not stop it', async () => {
  const v = vehicle('usedNormal');
  const write = (car) => buildTemplateDescription({ vehicle: car, dealer: DEALER, salesperson: { name: 'Pat', title: 'sales consultant' } });
  const good = write(v);
  const PAT = { name: 'Pat', title: 'sales consultant' };
  const checked = runGuardrails(good, { vehicle: v, dealer: DEALER, salesperson: PAT, price: v.price });
  // this record has no features on the website, and its own template still passes every check (it always reaches the word minimum)
  assert.deepEqual([checked.ok, checked.problems.map((p) => p.code), ruleProblems(checked)], [true, [], []]);
  const noCarfax = { ...v, carfaxOneOwner: false, carfaxUrl: '' };
  const cases = {
    'the dealership deleted': [v, good.replaceAll(DEALER.name, 'the lot')],
    'the role deleted': [v, good.replaceAll('sales consultant', 'here')],
    'an invented payment': [v, good + '\nOnly $199 a month.'],
    'posing as a private seller': [v, 'Selling my truck. ' + good],
    'a one-owner claim the data lacks': [noCarfax, write(noCarfax) + '\nOne owner, garage kept.'],
  };
  for (const [what, [car, description]] of Object.entries(cases)) {
    for (const probeOnly of [false, true]) {
      const o = formOpener({ description, car });
      await o.fns.openForm({ probeOnly });
      assert.ok(!o.calls.includes('tabs.create'), `${what}: the form is not opened (${probeOnly ? 'check fields' : 'fill'})`);
      // the one stop (fillBlocker): the dealership's name first, then every posting rule, each named
      const said = o.calls.find((c) => c.startsWith('status(error): '));
      assert.match(said || '', /^status\(error\): The description (doesn't name Example Motors|fails (a check|\d+ checks) that must pass before the form is filled: )/, `${what}: the status line says what to fix`);
      for (const p of ruleProblems(o.state.guardrails).filter((p) => p.code !== 'no-dealer')) assert.ok(said.includes(p.text), `${what}: ${p.text}`);
      assert.ok(ruleProblems(o.state.guardrails).length > 0);
    }
    // the dry run's Fill it in now checks the same text before filling
    const p = formOpener({ description, step: 'probe', car });
    await p.fns.fillFromProbe();
    assert.ok(!p.calls.some((c) => c.startsWith('runFill')), `${what}: Fill it in now does not fill`);
  }
  // the sparse record's own template, and a very short text that names the dealership and the role (only style warnings)
  for (const text of [good, `Sales consultant at ${DEALER.name}. VIN ${v.vin}.`]) {
    const g = runGuardrails(text, { vehicle: v, dealer: DEALER, salesperson: PAT, price: v.price });
    assert.ok(ruleProblems(g).length === 0 && (text === good || !g.ok), 'too short is a warning, not a rule');
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
        const text = `Sales consultant at ${DEALER.name}. VIN ${state.vehicle.vin}.`;
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
    assert.deepEqual(o.calls.filter((c) => c.startsWith('runFill')), [`runFill: Sales consultant at ${DEALER.name}. VIN ${B.vin}.`], `${what}: filled once, with B's text`);
    assert.equal(o.state.description, `Sales consultant at ${DEALER.name}. VIN ${B.vin}.`, `${what}: B's description`);
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
      state, flowRun: 0, fillsUnderWay: 0, watcher: null, FORM_MAP, VERSION: '0.0.0', onCreatePage, FORM_GONE_TEXT: 'gone',
      carStillCurrent: async () => true, fillBlocker: () => '', // a fresh read and a description that passes (their own tests are below)
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
    state, flowRun: 0, fillsUnderWay: 0, FORM_MAP, VERSION: '0.0.0', onCreatePage, FORM_GONE_TEXT: 'form gone',
    carStillCurrent: async () => true, fillBlocker: () => '', // a fresh read and a description that passes (their own tests are below)
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
  assert.match(src, /case 'fillAgain': return state\.step === 'publish' \? oneAtATime\(\(\) => runFill\(\{ photos: false \}\)\) : undefined;/, 'the Fill again button fills the fields only');

  // Attach photos again: every photo is sent once more, and the panel says the form may hold two of each
  const again = p.fns.attachPhotos(null, { again: true });
  await p.next();
  await again;
  assert.equal(count(), 4);
  assert.deepEqual([p.state.photos.attached, p.state.photos.again], [2, true]);
  const photosHtml = compile('photosHtml', { state: p.state, blockedPatterns: () => [], esc: (x) => String(x), patternCovers: () => false, patternHost: (x) => x, allowButton: () => '' });
  assert.match(photosHtml(), /each is on it twice now: remove the extra copies on Facebook before you publish/);
  assert.match(src, /case 'attachAgain':\s*await askForPhotos\(\);\s*return state\.step === 'publish' \? oneAtATime\(\(\) => attachAgain\(\)\)/, 'the Attach photos again button sends them all again');
  assert.match(fnText('attachAgain'), /return attachPhotos\(null, \{ again: true \}\);/);

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

// Fill again and Attach photos again on a form left open (overnight, say):
// the car is read again first when its last read is old, so the form is
// never filled again, nor given photos, from the old read; and a double click
// acts once. onClick as written, with the panel's own helpers it calls
// (oneAtATime, attachAgain); the fill, the photos and the read are stand-ins
// (runFill's own read again is checked with the other fills, below).
test('Fill again and Attach photos again act once per click, and Attach photos again reads the car again first', async () => {
  const calls = [];
  const holds = [];
  const hold = (what) => new Promise((resolve) => { calls.push(what); holds.push(resolve); });
  let same = true; // what the read again finds: the same car, or a change (the panel goes back to the review)
  const state = { step: 'publish', vin: 'AAA', fbTabId: 77, queueMode: false };
  const onClick = compileWithOwnHelpers('onClick', {
    state, flowRun: 0, listBusy: false, promptOpen: false,
    askForPhotos: async () => calls.push('askForPhotos'),
    carStillCurrent: async () => { calls.push('carStillCurrent'); if (!same) state.step = 'review'; return same; },
    runFill: (opts) => hold(`runFill ${JSON.stringify(opts)}`),
    attachPhotos: (only, opts) => hold(`attachPhotos ${JSON.stringify(opts)}`),
    setStatus: never('setStatus'), render: never('render'),
  });
  const click = (id) => onClick({ target: { closest: () => ({ id, dataset: {} }) } });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const release = async () => { while (holds.length) holds.shift()(); await tick(); };

  // Attach photos again: Chrome is asked first (in the click), then the car is read again, then the photos go
  click('attachAgain'); // not awaited: the photos are held until release()
  await tick();
  assert.deepEqual(calls, ['askForPhotos', 'carStillCurrent', 'attachPhotos {"again":true}']);
  // a second click while they are still being sent sends nothing more
  click('attachAgain');
  await tick();
  assert.equal(calls.filter((c) => c.startsWith('attachPhotos')).length, 1, `one photo run (${calls.join(' | ')})`);
  await release();
  // the website changed the car since the form was filled: back to the review, no photo sent
  calls.length = 0;
  same = false;
  await click('attachAgain');
  await tick();
  assert.deepEqual(calls, ['askForPhotos', 'carStillCurrent']);
  assert.equal(state.step, 'review');

  // Fill again: one fill at a time (runFill reads the car again itself)
  calls.length = 0;
  same = true;
  state.step = 'publish';
  click('fillAgain');
  click('fillAgain');
  await tick();
  assert.deepEqual(calls, ['runFill {"photos":false}'], 'a double click fills the form once');
  await release();
  click('fillAgain');
  await tick();
  assert.deepEqual(calls, ['runFill {"photos":false}', 'runFill {"photos":false}'], 'the next click once the fill is done fills it again');
  await release();
  // neither acts on a form that is not at the publish step any more
  calls.length = 0;
  state.step = 'review';
  await click('fillAgain');
  await click('attachAgain');
  await tick();
  assert.deepEqual(calls, ['askForPhotos']);
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
    const { confirmPosted } = compileMany(['confirmPosted', 'offeredLink'], {
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

// The posted entry keeps the price the form was filled with, on the price
// basis it was read under. The dealer can switch the price basis in Settings
// while a form waits for Publish (or before a saved post comes back):
// working the price out again from the new basis would record a price the
// listing does not show. The listing keeps the basis it was posted at, as
// every listing does when the setting changes (src/rescan.js postedBasis), so
// the next rescan compares it on that basis: the switch alone is no price
// change, a change of the website's price on that basis is. Run with
// sidepanel.js's own confirmPosted, the real markPosted and the real diffScans.
test('It\'s posted records the price the form was filled with on the basis it was read under: a later switch of the setting is no price change, a website change is', async () => {
  const car = { vin: 'AAA', name: 'Car A', price: 25000, priceBeforeFees: 24500 };
  const run = async ({ filledUnder, confirmUnder, price = basisPrice(car, filledUnder), priceBasis = filledUnder, website = car }) => {
    const store = { 'posted:o': {}, 'postLog:o': [] };
    const state = { origin: 'o', vin: 'AAA', step: 'publish', vehicle: car, price, priceBasis, settings: { basis: filledUnder, salesperson: { name: 'Pat' } }, detected: null, queueMode: false, posted: {}, postLog: [], map: FORM_MAP };
    const { confirmPosted } = compileMany(['confirmPosted', 'offeredLink'], {
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
    const before = { vehicles: { AAA: { ...car } } };
    const after = { vehicles: { AAA: { ...website } } };
    return { recorded: posted.AAA.price, basis: posted.AAA.basis, todo: diffScans(before, after, { posted, basis: confirmUnder }).priceUpdates };
  };
  // filled at the main price, then the dealer switched to the lower second price: the listing stays on the main price's basis
  const down = await run({ filledUnder: 'website', confirmUnder: 'beforeFees' });
  assert.deepEqual([down.recorded, down.basis, down.todo.length], [25000, 'website', 0], 'the price the listing shows, compared on its own basis');
  // the other way round
  const up = await run({ filledUnder: 'beforeFees', confirmUnder: 'website' });
  assert.deepEqual([up.recorded, up.basis, up.todo.length], [24500, 'beforeFees', 0]);
  // the website's price on the listing's basis moves: the next rescan asks for the update
  const moved = await run({ filledUnder: 'beforeFees', confirmUnder: 'website', website: { ...car, priceBeforeFees: 23900 } });
  assert.deepEqual(moved.todo.map((t) => [t.from, t.to]), [[24500, 23900]]);
  // no switch: the same price as before, and nothing to do
  const same = await run({ filledUnder: 'beforeFees', confirmUnder: 'beforeFees' });
  assert.deepEqual([same.recorded, same.todo.length], [24500, 0]);
  // a post saved before the basis was kept with its price: today's setting is its basis, and the gap shows
  const old = await run({ filledUnder: 'website', confirmUnder: 'beforeFees', priceBasis: null });
  assert.deepEqual([old.recorded, old.basis], [25000, 'beforeFees']);
  assert.deepEqual(old.todo.map((t) => [t.from, t.to]), [[25000, 24500]]);
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
    const { confirmPosted } = compileMany(['confirmPosted', 'offeredLink'], {
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
  // nothing typed: the listing the panel read and saw this car on, in a queue or not
  for (const queueMode of [false, true]) {
    assert.equal((await run({ detected: { status: 'listing', url: ITEM, id: '1234567890', verified: true }, queueMode })).entry.listingUrl, ITEM);
    // ...never one it found does not show this car, or one not read yet: no link, unless the person types one
    for (const detected of [{ status: 'listing', url: ITEM, id: '1234567890', unverified: true }, { status: 'listing', url: ITEM, id: '1234567890', checking: true }, { status: 'listing', url: ITEM, id: '1234567890' }]) {
      assert.equal((await run({ detected, queueMode })).entry.listingUrl, undefined, `${JSON.stringify(detected)}: another car's listing is never saved as this car's link`);
    }
  }
  const notThisCar = { status: 'listing', url: ITEM, id: '1234567890', unverified: true };
  const OWN = 'https://www.facebook.com/marketplace/item/2222222222/';
  assert.equal((await run({ detected: notThisCar, queueMode: true, typed: OWN })).entry.listingUrl, OWN);
  // in a queue, only a listing page the panel read and saw this car on gives the link: not one still being read,
  // nor one brought back from before a read (a panel opened again, or in a second window, before its own read)
  const seenThisCar = { status: 'listing', url: ITEM, id: '1234567890', verified: true };
  assert.equal((await run({ detected: seenThisCar, queueMode: true })).entry.listingUrl, ITEM);
  for (const unread of [{ ...seenThisCar, verified: undefined, checking: true }, { status: 'listing', url: ITEM, id: '1234567890' }, { status: 'listing', url: ITEM, id: '1234567890', afterCreate: false }]) {
    assert.equal((await run({ detected: unread, queueMode: true })).entry.listingUrl, undefined, JSON.stringify(unread));
  }
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
// (by default a listing whose page the panel read and saw this car on; null:
// nothing, a side panel in a second window, say). failQueueWrites:
// how many writes of the queue fail, as a full storage fails them.
// onUp: called once the next car is up. scope: stand-ins that replace the
// harness's own (slower pilot notes, say).
function queuePanel(store, { onNext = null, onUp = null, queueMode = true, detected = { status: 'listing', url: 'https://www.facebook.com/marketplace/item/1/', verified: true }, failQueueWrites = 0, scope = {} } = {}) {
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
  fns = compileMany(['confirmPosted', 'offeredLink', 'savedDraft', 'afterQueueStep', 'clearFlow', 'savedFlowIs'], {
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
    const one = queuePanel(store, { queueMode, detected: { status: 'listing', url: ITEM, verified: true } }); // the listing page read and seen to show this car
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
  const withLink = queuePanel(store, { queueMode: false, detected: { status: 'listing', url: ITEM, verified: true } });
  await withLink.fns.confirmPosted();
  assert.deepEqual(store['posted:' + O].AAA, { ...was, listingUrl: ITEM }, 'only the link is added');
  assert.equal(store['postLog:' + O].length, 1);

  // a colleague's entry for the car (synced in after the form opened): this person's post is recorded
  const shared = { ['posted:' + O]: { AAA: { name: 'Car A', price: 20000, postedAt: '2026-09-30T09:00:00.000Z', userId: 'u2', mine: false } } };
  const mine = queuePanel(shared, { queueMode: false, detected: { status: 'listing', url: ITEM, verified: true } });
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

// In a queue every listing page the Facebook tab goes to is read before the
// panel says anything about it, and the post is recorded without asking only
// when the form's own tab went straight from the form to a listing not
// already recorded, and that page shows this car.
// What the read-only listing reader sees on the page the tab moved to: this
// car's new listing (its VIN in the page's text, no form), another car's
// listing, or the create form still drawn under the listing's address (a page
// that has not redrawn yet, or another listing opened over it), which carries
// this car everywhere: its boxes, its preview, its Price box.
const THIS_CAR = { matchesId: true, sold: false, unavailable: false, matchesVin: true, vinInText: true, formOnPage: false, hasPriceBox: false, matchesName: true, matchesPrice: true };
const OTHER_CAR = { matchesId: true, sold: false, unavailable: false, matchesVin: false, vinInText: false, formOnPage: false, hasPriceBox: false, matchesName: false, matchesPrice: false };
const FORM_STILL = { ...THIS_CAR, formOnPage: true, hasPriceBox: true };
// What the publish step shows at a render: its banner's class and words, and
// the Listing link box's value (sidepanel.js's own viewPublish).
function publishShows(view) {
  const html = view();
  const banner = /<div class="banner (\w+)" id="detected">(.*?)<\/div>/.exec(html);
  return { banner: banner ? `${banner[1]}: ${banner[2].replace(/<[^>]+>/g, '')}` : 'waiting', box: /id="listingUrl" value="([^"]*)"/.exec(html)[1] };
}
const viewStubs = { carCard: () => '', languageHint: () => '', photosHtml: () => '', photoServersHtml: () => '', blockedPatterns: () => [], copyBtn: () => '', esc: (t) => String(t ?? '').replace(/"/g, '&quot;'), money: (n) => '$' + n.toLocaleString('en-US') };
// sidepanel.js's own startWatcher, postsWindow, confirmIfThisCar, offeredLink
// and viewPublish, with the real isNewListingFromForm, showsPostedCar and
// namesakesOf; `pages` is what each read of the listing page gives (an
// Error: the read failed), the last one repeated; `during(n, state)` runs at
// the n-th read. Each render records what the publish step shows.
async function queueWatch({ queueMode, result, posted = {}, windowId = null, panelWindowId = null, pages = [THIS_CAR], during = null, detected = null }) {
  const calls = [];
  const reads = [];
  const shown = [];
  const state = { step: 'publish', queueMode, fbTabId: 77, map: FORM_MAP, posted, detected, windowId, vin: 'AAA', vehicle: { vin: 'AAA', name: '2020 Make Model', price: 21000 }, price: 20000, settings: { basis: 'website' }, fill: null };
  let fns;
  fns = compileMany(['startWatcher', 'postsWindow', 'confirmIfThisCar', 'offeredLink', 'viewPublish', 'onInput'], {
    state, watcher: null, isNewListingFromForm, showsPostedCar, namesakesOf, basisPrice, panelWindowId, flowRun: 0,
    sleep: async () => {}, VERIFY_READS: 6, VERIFY_EVERY_MS: 1500, readListingInPage: 'the listing reader', LISTING_SIGNS: 'the listing signs',
    chrome: {
      scripting: {
        executeScript: async ({ target, func, args }) => {
          reads.push({ tabId: target.tabId, func, signs: args[1], expect: args[2] });
          if (during) during(reads.length, state, fns);
          const page = pages[Math.min(reads.length, pages.length) - 1];
          if (page instanceof Error) throw page;
          return [{ result: page }];
        },
      },
    },
    watchForListing: (opts) => {
      calls.push('watch ' + opts.createUrl);
      return { promise: Promise.resolve(result), cancel: () => {} };
    },
    confirmPosted: async () => calls.push('confirmPosted ' + fns.offeredLink(state.detected)),
    render: () => {
      calls.push('render');
      shown.push(publishShows(fns.viewPublish));
    },
    saveFlow: () => calls.push('saveFlow'),
    ...viewStubs,
  });
  fns.startWatcher();
  for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  return { calls, state, reads, shown, fns };
}
const READING = 'info: The Facebook tab is on a listing page. Lot Current is reading it (only reading) to see whether it shows 2020 Make Model…';
const NOT_CONFIRMED = /^warn: The Facebook tab is on a listing page, and Lot Current couldn't confirm that it shows 2020 Make Model \(its VIN, or its name at \$20,000\), so the queue did not record it by itself/;
const POSTED = 'good: Looks like it posted. Confirm below to record it.';

test('in a queue, only a new listing the form\'s tab moved to straight from the form is recorded without asking', async () => {
  const ITEM = 'https://www.facebook.com/marketplace/item/555/';
  const run = queueWatch;
  const fromForm = { status: 'listing', url: ITEM, id: '555', afterCreate: true };
  const q = await run({ queueMode: true, result: fromForm });
  assert.deepEqual(q.calls, ['watch ' + FORM_MAP.createUrl, 'render', 'confirmPosted ' + ITEM], 'published from the form, and the listing shows this car: recorded with its link, next car');
  assert.deepEqual(q.shown, [{ banner: READING, box: '' }], 'while the page is read, the panel says so, and offers no link');
  assert.deepEqual(q.reads, [{ tabId: 77, func: 'the listing reader', signs: 'the listing signs', expect: { id: '555', name: '2020 Make Model', prices: [20000], vin: 'AAA' } }], 'the form\'s tab is read once, for this listing\'s id and this car at the price the form was filled with');
  const own = await run({ queueMode: true, result: fromForm, windowId: 5, panelWindowId: 5 });
  assert.deepEqual(own.calls, ['watch ' + FORM_MAP.createUrl, 'render', 'confirmPosted ' + ITEM], 'the side panel of the window the post started in records it');
  // a side panel in a second window watches the same tab: it reads the page
  // and shows the listing (so its It's posted keeps the link) but never
  // records it by itself, and leaves the saved post to the panel it belongs to
  const second = await run({ queueMode: true, result: fromForm, windowId: 5, panelWindowId: 9 });
  assert.deepEqual(second.calls, ['watch ' + FORM_MAP.createUrl, 'render', 'render'], `a second window: read, shown, not recorded, not saved (${second.calls.join(' | ')})`);
  assert.deepEqual(second.shown, [{ banner: READING, box: '' }, { banner: POSTED, box: ITEM }]);
  // any other listing address in a queue is read too: shown as posted, with its link, only when it shows this car, and never recorded by itself
  for (const [what, opts] of [
    ['a listing browsed to', { queueMode: true, result: { ...fromForm, url: 'https://www.facebook.com/marketplace/item/987654321/', id: '987654321', afterCreate: false } }],
    ['a listing the tab already showed', { queueMode: true, result: { ...fromForm, afterCreate: false } }],
    ['a listing already recorded', { queueMode: true, result: fromForm, posted: { OTHER: { listingUrl: ITEM } } }],
  ]) {
    const r = await run(opts);
    assert.deepEqual(r.calls, ['watch ' + FORM_MAP.createUrl, 'render', 'render', 'saveFlow'], `${what}: read, shown, saved, not recorded without the person`);
    assert.deepEqual(r.shown, [{ banner: READING, box: '' }, { banner: POSTED, box: opts.result.url }], what);
    assert.deepEqual(r.state.detected, { ...opts.result, verified: true });
    assert.equal(r.reads.length, 1);
    const other = await run({ ...opts, pages: [OTHER_CAR] });
    assert.ok(!other.calls.includes('confirmPosted'), what);
    assert.equal(other.shown.length, 2);
    assert.match(other.shown[1].banner, NOT_CONFIRMED, `${what}, of another car`);
    assert.equal(other.shown[1].box, '', `${what}, of another car: no link offered`);
  }
});

// A single post, and a queued car left on its form by Stop queue: the listing
// page the tab goes to is read too, and only one that shows this car is
// offered as its link; one of another car (a notification clicked on the
// form, say) is not, before or after the panel is opened again. Neither is
// ever recorded by itself: the person clicks It's posted, record it.
const NOT_CONFIRMED_SINGLE = /^warn: The Facebook tab is on a listing page, and Lot Current couldn't confirm that it shows 2020 Make Model \(its VIN, or its name at \$20,000\), so its address isn't offered as this car's link\. If you clicked Publish and it posted, paste its listing link below if you have it and click It's posted, record it\.$/;
test('a single post offers a listing as its link only when the page shows this car, after Stop queue and a reopen too', async () => {
  const ITEM = 'https://www.facebook.com/marketplace/item/555/';
  const fromForm = { status: 'listing', url: ITEM, id: '555', afterCreate: true };
  // this car's new listing: read, then shown as posted with its link, and saved; the person confirms it
  const mine = await queueWatch({ queueMode: false, result: fromForm });
  assert.deepEqual(mine.calls, ['watch ' + FORM_MAP.createUrl, 'render', 'render', 'saveFlow'], 'read, shown, saved, not recorded without the person');
  assert.deepEqual(mine.shown, [{ banner: READING, box: '' }, { banner: POSTED, box: ITEM }]);
  assert.deepEqual(mine.reads.map((r) => r.expect), [{ id: '555', name: '2020 Make Model', prices: [20000], vin: 'AAA' }]);
  assert.equal(mine.fns.offeredLink(mine.state.detected), ITEM);
  // another car's listing the form's tab went to: never offered as this car's link
  for (const result of [fromForm, { ...fromForm, afterCreate: false }]) {
    const other = await queueWatch({ queueMode: false, result, pages: [OTHER_CAR] });
    assert.ok(!other.calls.some((c) => c.startsWith('confirmPosted')));
    assert.deepEqual(other.shown.map((v) => v.box), ['', ''], 'the other listing\'s address is never in the Listing link box');
    assert.equal(other.shown[0].banner, READING);
    assert.match(other.shown[1].banner, NOT_CONFIRMED_SINGLE);
    assert.equal(other.fns.offeredLink(other.state.detected), '', "It's posted with nothing typed saves no link");
  }
  // Stop queue left the queued car on its form as a single post, with the listing it could not confirm; the panel is opened again on it
  const OTHER = 'https://www.facebook.com/marketplace/item/616161/';
  const saved = { status: 'listing', url: OTHER, id: '616161', afterCreate: true, unverified: true, name: '2020 Make Model', price: 20000 };
  const h = await queueWatch({ queueMode: false, result: { status: 'listing', url: OTHER, id: '616161', afterCreate: false }, pages: [OTHER_CAR], detected: null });
  const { resumeFlow } = compileMany(['resumeFlow'], {
    state: h.state, FLOW_FIELDS, GLOBAL_KEYS: { devOverrides: 'devOverrides' }, applyOverrides, FORM_MAP,
    chrome: { storage: { local: { get: async () => ({}) } } }, loadSaved: async () => {},
    render: () => h.shown.push(publishShows(h.fns.viewPublish)), startWatcher: () => h.fns.startWatcher(),
  });
  h.shown.length = 0;
  await resumeFlow('https://www.example-motors.test', { vin: 'AAA', step: 'publish', queueMode: false, fbTabId: 77, vehicle: h.state.vehicle, price: 20000, detected: saved });
  for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(h.shown.length >= 3, `shown when it comes back, while read, after (${h.shown.length})`);
  for (const v of h.shown) {
    assert.notEqual(v.banner, POSTED, 'never "Looks like it posted"');
    assert.equal(v.box, '', 'the listing the queue could not confirm is never offered as this car\'s link');
  }
  assert.match(h.shown.at(-1).banner, NOT_CONFIRMED_SINGLE);
  assert.equal(h.fns.offeredLink(h.state.detected), '');
});

// A notification ("Someone is interested in your ...") or a listing clicked
// on the form page before Publish also takes the form's tab straight from the
// form to a listing not yet recorded. The page is read, and only one that
// shows this car is recorded by itself; another car's listing leaves the
// panel asking, with that listing's address out of the Listing link box. The
// create form still drawn under the new address is never taken for the
// listing, though it carries this car's VIN, name and price.
test('in a queue, a listing reached from the form page that does not show this car is not recorded: the panel asks', async () => {
  const ITEM = 'https://www.facebook.com/marketplace/item/555/';
  const fromForm = { status: 'listing', url: ITEM, id: '555', afterCreate: true };
  // another car's listing, read while it loads and after: never recorded, and the panel asks
  const other = await queueWatch({ queueMode: true, result: fromForm, pages: [new Error('Frame with ID 0 is still loading'), OTHER_CAR] });
  assert.ok(!other.calls.some((c) => c.startsWith('confirmPosted')), other.calls.join(' | '));
  assert.equal(other.reads.length, 6, 'read six times, 1.5 s apart, while the page loads');
  assert.deepEqual(other.calls, ['watch ' + FORM_MAP.createUrl, 'render', 'render', 'saveFlow'], 'shown as being read, then as not confirmed, and saved');
  assert.deepEqual(other.state.detected, { ...fromForm, unverified: true, name: '2020 Make Model', price: 20000 }, 'the panel says it could not confirm the page shows this car');
  assert.equal(other.shown[0].banner, READING);
  assert.match(other.shown[1].banner, NOT_CONFIRMED);
  assert.deepEqual(other.shown.map((v) => v.box), ['', ''], 'the other listing\'s address is never offered as this car\'s link');
  // the create form still drawn at the new address: never the post, however long it stays; the listing once it is drawn
  const form = await queueWatch({ queueMode: true, result: fromForm, pages: [FORM_STILL] });
  assert.deepEqual([form.reads.length, form.calls.some((c) => c.startsWith('confirmPosted')), form.state.detected.unverified], [6, false, true]);
  const redrawn = await queueWatch({ queueMode: true, result: fromForm, pages: [FORM_STILL, { ...FORM_STILL, hasPriceBox: false }, THIS_CAR] });
  assert.deepEqual([redrawn.calls.at(-1), redrawn.reads.length], ['confirmPosted ' + ITEM, 3]);
  // this car's VIN only in a box (the form's own description), not in the page's text: not the listing
  const inBox = await queueWatch({ queueMode: true, result: fromForm, pages: [{ ...OTHER_CAR, matchesVin: true }] });
  assert.equal(inBox.state.detected.unverified, true);
  // a page still loading, then the new listing: recorded at the read that shows it
  const late = await queueWatch({ queueMode: true, result: fromForm, pages: [new Error('no frame yet'), { ...THIS_CAR, matchesId: false }, THIS_CAR] });
  assert.deepEqual([late.calls.at(-1), late.reads.length], ['confirmPosted ' + ITEM, 3]);
  // its name and price only: enough when no other posted car has the name, never when one does
  const nameAndPrice = { ...OTHER_CAR, matchesName: true, matchesPrice: true };
  assert.equal((await queueWatch({ queueMode: true, result: fromForm, pages: [nameAndPrice] })).calls.at(-1), 'confirmPosted ' + ITEM);
  const twin = await queueWatch({ queueMode: true, result: fromForm, pages: [nameAndPrice], posted: { BBB: { name: '2020 Make Model', price: 20000 } } });
  assert.ok(!twin.calls.some((c) => c.startsWith('confirmPosted')), 'another posted car of the same name: only its VIN tells them apart');
  assert.equal(twin.state.detected.unverified, true);
  // the person clicks It's posted (or the post ends) while the page is read: the reads stop and nothing more is said
  const clicked = await queueWatch({ queueMode: true, result: fromForm, pages: [OTHER_CAR], during: (n, state) => { if (n === 2) state.step = 'done'; } });
  assert.deepEqual([clicked.reads.length, clicked.calls.some((c) => c.startsWith('confirmPosted')), clicked.state.detected], [2, false, { ...fromForm, checking: true }]);
  // a second window's panel reads it too: it says the same, offers no link, and leaves the saved post alone
  const second = await queueWatch({ queueMode: true, result: fromForm, pages: [OTHER_CAR], windowId: 5, panelWindowId: 9 });
  assert.deepEqual(second.calls, ['watch ' + FORM_MAP.createUrl, 'render', 'render']);
  assert.match(second.shown[1].banner, NOT_CONFIRMED);
  assert.equal(second.shown[1].box, '');
});

// The panel closed and opened again (or opened in a second window) while the
// form's tab shows another car's listing: the saved post comes back with the
// listing marked as not confirmed, and the watcher reports the same listing
// again, this time as one the tab already showed. It is read again; at no
// render does the panel say it posted or offer that listing's address as this
// car's link. Run with sidepanel.js's own resumeFlow and the functions above.
test('in a queue, a panel opened again on another car\'s listing reads it again and never offers it as this car\'s', async () => {
  const OTHER = 'https://www.facebook.com/marketplace/item/616161/';
  const saved = { status: 'listing', url: OTHER, id: '616161', afterCreate: true, unverified: true, name: '2020 Make Model', price: 20000 };
  for (const [windowId, panelWindowId] of [[5, 5], [5, 9]]) {
    const watched = { status: 'listing', url: OTHER, id: '616161', afterCreate: false };
    const h = await queueWatch({ queueMode: true, result: watched, pages: [OTHER_CAR], windowId, panelWindowId, detected: null });
    const { resumeFlow } = compileMany(['resumeFlow'], {
      state: h.state, FLOW_FIELDS, GLOBAL_KEYS: { devOverrides: 'devOverrides' }, applyOverrides, FORM_MAP,
      chrome: { storage: { local: { get: async () => ({}) } } }, loadSaved: async () => {},
      render: () => h.shown.push(publishShows(h.fns.viewPublish)), startWatcher: () => h.fns.startWatcher(),
    });
    h.shown.length = 0;
    await resumeFlow('https://www.example-motors.test', { vin: 'AAA', step: 'publish', queueMode: true, fbTabId: 77, windowId, vehicle: h.state.vehicle, price: 20000, detected: saved });
    for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    const where = `post from window ${windowId}, panel in window ${panelWindowId}`;
    assert.ok(h.shown.length >= 3, `${where}: shown when it comes back, while read, after (${h.shown.length})`);
    for (const v of h.shown) {
      assert.notEqual(v.banner, POSTED, `${where}: never "Looks like it posted"`);
      assert.equal(v.box, '', `${where}: the other listing's address is never in the Listing link box`);
    }
    assert.match(h.shown[0].banner, NOT_CONFIRMED, `${where}: as saved`);
    assert.equal(h.shown[1].banner, READING);
    assert.match(h.shown.at(-1).banner, NOT_CONFIRMED);
    assert.equal(h.fns.offeredLink(h.state.detected), '', `${where}: It's posted with nothing typed saves no link`);
    assert.equal(h.reads.length, 12, `${where}: read again (once before it was reopened, once after)`);
  }
});

// A link the person types into Listing link while the panel reads the listing
// page (up to six reads, 1.5 s apart) stays there when the result is drawn,
// whatever the read offers: It's posted saves the person's link. And a read
// the panel never finished (it was closed during the read, or the post was
// saved by an older version) is not shown again as under way when the panel
// comes back with the tab on another page: nothing is reading it. Run with
// sidepanel.js's own onInput, viewPublish and resumeFlow.
test('a link typed into Listing link stays through the listing check, and a check cut short is not shown as still reading', async () => {
  const ITEM = 'https://www.facebook.com/marketplace/item/555/';
  const OWN = 'https://www.facebook.com/marketplace/item/2222222222/';
  const fromForm = { status: 'listing', url: ITEM, id: '555', afterCreate: false };
  const type = (fns, value) => fns.onInput({ target: { id: 'listingUrl', value } });
  for (const [queueMode, pages, banner] of [[true, [OTHER_CAR], NOT_CONFIRMED], [false, [OTHER_CAR], NOT_CONFIRMED_SINGLE], [false, [THIS_CAR], null]]) {
    const h = await queueWatch({ queueMode, result: fromForm, pages, during: (n, state, fns) => { if (n === 1) type(fns, OWN); } });
    const what = `${queueMode ? 'queue' : 'single post'}, ${pages[0] === THIS_CAR ? 'this car' : 'another car'}`;
    assert.equal(h.shown.at(-1).box, OWN, `${what}: the typed link is still in the box`);
    if (banner) assert.match(h.shown.at(-1).banner, banner, what);
    else assert.equal(h.shown.at(-1).banner, POSTED, what);
    assert.equal(h.state.listingTyped, OWN);
  }
  // a box the person emptied stays empty: the person's word, not the offered link
  const emptied = await queueWatch({ queueMode: false, result: fromForm, pages: [THIS_CAR], during: (n, state, fns) => { if (n === 1) type(fns, ''); } });
  assert.deepEqual(emptied.shown.at(-1), { banner: POSTED, box: '' });

  // brought back with a listing that was being read (or never read), the tab now elsewhere: waiting, not "reading"
  for (const detected of [{ status: 'listing', url: ITEM, id: '555', checking: true }, { status: 'listing', url: ITEM, id: '555' }]) {
    const h = await queueWatch({ queueMode: true, result: { status: 'cancelled', url: null }, detected: null });
    const { resumeFlow } = compileMany(['resumeFlow'], {
      state: h.state, FLOW_FIELDS, GLOBAL_KEYS: { devOverrides: 'devOverrides' }, applyOverrides, FORM_MAP,
      chrome: { storage: { local: { get: async () => ({}) } } }, loadSaved: async () => {},
      render: () => h.shown.push(publishShows(h.fns.viewPublish)), startWatcher: () => h.fns.startWatcher(),
    });
    h.shown.length = 0;
    await resumeFlow('https://www.example-motors.test', { vin: 'AAA', step: 'publish', queueMode: true, fbTabId: 77, vehicle: h.state.vehicle, price: 20000, detected });
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(h.shown, [{ banner: 'waiting', box: '' }], `${JSON.stringify(detected)}: waiting for Publish, nothing said to be reading`);
    assert.equal(h.state.detected, null);
  }
  // one the panel had decided keeps what it said until the tab is read again
  for (const detected of [{ status: 'listing', url: ITEM, id: '555', verified: true }, { status: 'listing', url: ITEM, id: '555', unverified: true, name: '2020 Make Model', price: 20000 }]) {
    const h = await queueWatch({ queueMode: true, result: { status: 'cancelled', url: null }, detected: null });
    const { resumeFlow } = compileMany(['resumeFlow'], {
      state: h.state, FLOW_FIELDS, GLOBAL_KEYS: { devOverrides: 'devOverrides' }, applyOverrides, FORM_MAP,
      chrome: { storage: { local: { get: async () => ({}) } } }, loadSaved: async () => {}, render: () => {}, startWatcher: () => {},
    });
    await resumeFlow('https://www.example-motors.test', { vin: 'AAA', step: 'publish', queueMode: true, fbTabId: 77, vehicle: h.state.vehicle, price: 20000, detected });
    assert.deepEqual(h.state.detected, detected);
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

// Skip this car on the queue bar while a queued car's form is being opened
// and filled, or filled again (Fill it in now, Fill again): a fill already
// sent lands in that tab whatever the panel does next, so the queue must not
// move past the car and leave its form filled and unrecorded. Once the form
// is on screen and no fill is under way, Skip moves on as before. onClick and
// runFill as written, in one scope; Chrome's injection waits for the test.
test('Skip this car waits while a queued car\'s Marketplace form is being opened or filled', async () => {
  const calls = [];
  const answers = [];
  const FORM_STEPS = new Function(`return ${/const FORM_STEPS = (\[[^\]]*\]);/.exec(src)[1]}`)();
  const v = vehicle('usedNormal');
  const state = {
    origin: 'https://www.example-motors.test', vin: v.vin, vehicle: v, step: 'filling', queueMode: true, fbTabId: 77, map: FORM_MAP, settings: { basis: 'website' },
    listing: { fields: { description: 'x' }, photos: [] }, fill: null, detected: null, queue: { vins: [v.vin, 'BBB'], index: 0, status: 'running', results: {} },
  };
  const fns = compileMany(['formOpen', 'onClick', 'runFill'], {
    state, FORM_STEPS, promptOpen: false, flowRun: 0, fillsUnderWay: 0, VERSION: '0.0.0', nameOf: (vin) => vin,
    formTabShows: async () => true, FORM_GONE_TEXT: 'gone', carStillCurrent: async () => true, fillBlocker: () => '', fillFormInPage: 'fill',
    chrome: { scripting: { executeScript: () => new Promise((resolve) => answers.push(() => resolve([{ result: { filled: [], partial: [], blocked: [], photoLimit: { value: 20, verified: true } } }]))) } },
    render: () => {}, saveFlow: async () => {}, pilotNote: async () => {}, noteFill: (p) => p, notePostStep: (p) => p,
    startWatcher: () => {}, attachPhotos: async () => {},
    afterQueueStep: async (outcome) => calls.push('afterQueueStep ' + outcome),
    setStatus: (text, kind) => calls.push(`status(${kind}): ${text}`),
    advance, saveQueue: async () => {},
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const skip = () => fns.onClick({ target: { closest: () => ({ id: 'queueSkip', dataset: {} }) } });
  const skipped = () => calls.filter((c) => c.startsWith('afterQueueStep')).length;
  const WAIT = new RegExp(`^status\\(error\\): Lot Current is still working on ${v.name}'s Marketplace form\\. Wait until the panel shows the form, then click Skip this car`);

  // the form is being opened (openForm's step, before the fill): Skip waits, and says so
  await skip();
  assert.equal(skipped(), 0, 'the queue stays on the car whose form is being opened');
  assert.match(calls.at(-1), WAIT);
  // the fill is sent into the tab: Skip waits until it answers
  const first = fns.runFill({ opened: true });
  await tick();
  assert.equal(answers.length, 1, 'the fill is under way');
  await skip();
  assert.equal(skipped(), 0, 'not while the form is being filled');
  answers.shift()();
  await first;
  assert.equal(state.step, 'publish');
  // Fill again on the filled form (Fill it in now on the dry run's is the same fill): Skip waits for it too
  for (const step of ['publish', 'probe']) {
    state.step = step;
    const again = fns.runFill();
    await tick();
    await skip();
    assert.equal(skipped(), 0, `${step}: not while the form is being filled again`);
    assert.match(calls.at(-1), WAIT);
    answers.shift()();
    await again;
  }
  // the form is on screen and nothing is being filled: Skip moves on, as before
  assert.equal(state.step, 'publish');
  await skip();
  assert.deepEqual(calls.filter((c) => c.startsWith('afterQueueStep')), ['afterQueueStep skipped']);
  // a single post being filled is not the queue's car: the queue bar's Skip moves the paused queue only, as before
  Object.assign(state, { queueMode: false, step: 'filling', queue: { vins: ['CCC', 'DDD'], index: 0, status: 'paused', results: {} } });
  await skip();
  assert.equal(currentVin(state.queue), 'DDD');
  assert.deepEqual([state.vin, state.step, skipped()], [v.vin, 'filling', 1], 'the post is left as it is');
});

// The review screen's buttons follow the description's checks: drawn off
// (viewReview) and switched off or on as the person types (onInput, through
// setFormButtons) while a posting rule is broken, and off at the day's cap.
test('Open the Marketplace form and Check fields are off while the description breaks a posting rule or the cap is reached, and on again once it is fixed', () => {
  const v = vehicle('usedNormal');
  const good = buildTemplateDescription({ vehicle: v, dealer: DEALER, salesperson: { name: 'Pat', title: 'sales consultant' } });
  const bad = good.replaceAll(DEALER.name, 'the lot');
  const PAT = { name: 'Pat', title: 'sales consultant' };
  const check = (text) => runGuardrails(text, { vehicle: v, dealer: DEALER, salesperson: PAT, price: v.price });
  let cap = { reached: false, used: 0, cap: 10 };
  const buttons = { openForm: { disabled: false }, checkForm: { disabled: false } };
  const state = { vehicle: v, price: v.price, description: good, guardrails: check(good), note: '', descriptionSource: 'template', settings: { dealer: DEALER, salesperson: PAT, rewrite: { enabled: false } } };
  const blank = () => '';
  const fns = compileMany(['viewReview', 'setFormButtons', 'onInput'], {
    state, ruleProblems, runGuardrails, dailyCap: () => cap, inputTimer: null,
    ctx: () => ({ vehicle: state.vehicle, dealer: DEALER, salesperson: state.settings && state.settings.salesperson, priceNote: '', price: state.price, closingLine: '' }),
    setTimeout: (fn) => fn(), clearTimeout: () => {}, saveFlow: () => {}, renderList: never('renderList'),
    $: (id) => buttons[id] || null, esc: (s) => String(s ?? ''),
    relistHtml: blank, carCard: blank, readAgainHtml: blank, sourcePill: blank, checksHtml: blank, highlightsHtml: blank, photoPickHtml: blank,
    fieldsTable: blank, vinCheckHtml: blank, assumptionsHtml: blank, capHtml: blank, photoServersHtml: blank,
  }, BLOCKER_CONSTS);
  const drawnOff = () => ['openForm', 'checkForm'].map((id) => new RegExp(`id="${id}" disabled`).test(fns.viewReview()));
  assert.deepEqual(drawnOff(), [false, false], 'a description that passes: both on');
  state.guardrails = check(bad);
  assert.deepEqual(drawnOff(), [true, true], 'the dealership not named: both drawn off');
  state.guardrails = check(good);
  cap = { reached: true, used: 10, cap: 10 };
  assert.deepEqual(drawnOff(), [true, true], 'at the cap: both drawn off');
  cap = { reached: false, used: 0, cap: 10 };
  // no dealership name set in Settings: both drawn off, with the reason above them
  state.settings.dealer = { ...DEALER, name: '  ' };
  assert.deepEqual(drawnOff(), [true, true], 'no dealership name: both drawn off');
  assert.match(fns.viewReview(), /<div class="banner bad" id="noDealer">Add your dealership's name in Settings first \(Dealership name\)/);
  state.settings.dealer = DEALER;
  assert.doesNotMatch(fns.viewReview(), /id="noDealer"/);

  // typing: the buttons follow the text in the box
  fns.onInput({ target: { id: 'description', value: bad } });
  assert.deepEqual([buttons.openForm.disabled, buttons.checkForm.disabled], [true, true], 'off as the rule breaks');
  assert.equal(state.descriptionSource, 'edited');
  fns.onInput({ target: { id: 'description', value: good + '\nAsk about the 2 keys.' } });
  assert.deepEqual([buttons.openForm.disabled, buttons.checkForm.disabled], [true, true], 'an unsourced number keeps them off');
  fns.onInput({ target: { id: 'description', value: good } });
  assert.deepEqual([buttons.openForm.disabled, buttons.checkForm.disabled], [false, false], 'on again once fixed');
  fns.onInput({ target: { id: 'description', value: `Sales consultant at ${DEALER.name}. VIN ${v.vin}.` } });
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
    relistHtml: blank, carCard: blank, readAgainHtml: blank, sourcePill: blank, checksHtml: blank, highlightsHtml: blank, photoPickHtml: blank,
    fieldsTable: blank, vinCheckHtml: blank, assumptionsHtml: blank, capHtml: blank, photoServersHtml: blank,
    promptOpen: false, nameOf: (vin) => vin,
    clearFlow: async () => { calls.push('clearFlow'); Object.assign(state, { step: 'idle', vin: null, vehicle: null }); },
    setStatus: (text) => calls.push('status: ' + text), render: () => calls.push('render:' + state.step),
  }, BLOCKER_CONSTS);
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

// ---------- the dealership's name, and the one stop every opening and fill goes through ----------
const NO_NAME = "Add your dealership's name in Settings first (Dealership name): every description names the dealership.";
const PAT_SC = { name: 'Pat', title: 'sales consultant' };

test('the Marketplace form is not opened while no dealership name is set: no description could name the dealership', async () => {
  assert.equal(new Function(`${constText('NO_DEALER_TEXT')}\nreturn NO_DEALER_TEXT;`)(), NO_NAME);
  const v = vehicle('usedNormal');
  const description = buildTemplateDescription({ vehicle: v, dealer: DEALER, salesperson: PAT_SC });
  for (const dealer of [{ name: '' }, { name: '   ' }, {}]) {
    // checking the fields opens the same form, so it waits for the name too
    for (const probeOnly of [false, true]) {
      const o = formOpener({ description });
      o.state.settings.dealer = dealer;
      await o.fns.openForm({ probeOnly });
      assert.deepEqual(o.forms, [], `${JSON.stringify(dealer)}: no tab (${probeOnly ? 'check fields' : 'fill'})`);
      assert.ok(o.calls.includes(`status(error): ${NO_NAME}`), `${JSON.stringify(dealer)}: the status line says why (${o.calls.join(' | ')})`);
    }
  }
  const named = formOpener({ description });
  await named.fns.openForm();
  assert.equal(named.forms.length, 1, 'with a name the form opens');
  // the review step shows why and keeps both buttons off
  assert.match(fnText('viewReview'), /const formOff = cap\.reached \|\| !dealerNamed\(\) \|\| ruleProblems\(state\.guardrails\)\.length > 0;/);
  assert.match(fnText('viewReview'), /id="openForm" \$\{formOff \? 'disabled' : ''\}/);
  assert.match(fnText('setFormButtons'), /const off = cap\.reached \|\| !dealerNamed\(\) \|\| ruleProblems\(state\.guardrails\)\.length > 0;/);
});

test('the panel checks every description against the salesperson\'s own role', () => {
  // the checks' context carries the salesperson, so their title from Settings is the role looked for
  assert.match(src, /^const ctx = \(\) => \(\{[^\n]*\bsalesperson: state\.settings\.salesperson\b/m);
});

// The rest of the checks, passing, for the tests about the dealership's name
// alone (fillBlocker runs them after the name; the tests further down run the real ones).
const PASSING_CHECKS_NAMES = ['runGuardrails', 'ruleProblems', 'ctx'];
const PASSING_CHECKS = [() => ({ ok: true, problems: [], words: 80 }), (g) => g.problems, () => ({})];

// dealerNamed, NO_DEALER_TEXT and fillBlocker as sidepanel.js writes them.
function dealerChecks() {
  return [...BLOCKER_CONSTS.map(constText), fnText('fillBlocker')].join('\n');
}

// runFill as sidepanel.js writes it, on a form that is still on screen and a
// read of the car that is still current; checks: the rest of the checks.
function fillerFor(state, { said, typed, filled = async () => { throw new Error('filled'); }, current = async () => true, checks = PASSING_CHECKS }) {
  const names = ['state', 'setStatus', 'render', 'chrome', 'saveFlow', 'fillFormInPage', 'flowRun', 'fillsUnderWay', 'formTabShows', 'FORM_GONE_TEXT', 'carStillCurrent', ...PASSING_CHECKS_NAMES, 'usableClosingLine'];
  return new Function(...names, `${dealerChecks()}\n${fnText('runFill')}\nreturn runFill;`)(
    state,
    (text, tone) => said.push([text, tone]),
    () => {},
    { scripting: { executeScript: async (inj) => { typed.push(inj.args[1].fields.description); return [{ result: {} }]; } } },
    filled, // the first step after the form is filled
    function fillFormInPage() {},
    0,
    0,
    async () => true,
    'gone',
    current,
    ...checks,
    template.usableClosingLine,
  );
}

test('no way of filling the form types a description that does not name the dealership', async () => {
  // runFill is what "Fill it in now" (after a fields check) and "Fill again" call, and what Open the Marketplace form ends in
  const fill = async (dealer, description, step = 'probe') => {
    const said = [];
    const typed = [];
    const state = { settings: { dealer }, listing: { fields: { description } }, step, map: { fields: [], photoLimitDefault: 20 } };
    const runFill = fillerFor(state, { said, typed });
    try {
      await runFill();
    } catch (e) {
      assert.equal(e.message, 'filled');
    }
    return { said, typed, step: state.step };
  };
  for (const dealer of [{ name: '' }, { name: '  ' }, {}]) {
    const r = await fill(dealer, 'A fine truck. Sales consultant.');
    assert.deepEqual(r.typed, [], `nothing typed with no name: ${JSON.stringify(dealer)}`);
    assert.deepEqual(r.said, [[NO_NAME, 'error']]);
  }
  const stale = await fill({ name: 'Example Motors' }, 'A fine truck. Sales consultant.');
  assert.deepEqual(stale.typed, [], 'a description written before the name was set is not typed');
  assert.match(stale.said[0][0], /^The description doesn't name Example Motors, and every description names the dealership\./);
  assert.equal(stale.said[0][1], 'error');
  assert.equal(stale.step, 'probe', 'the fields check stays on screen');
  assert.equal((await fill({ name: 'Example Motors' }, 'A fine truck.', 'filling')).step, 'review', 'a blocked fill never leaves the panel on "Filling in the form"');
  const good = await fill({ name: 'Example Motors' }, 'A fine truck. Sales consultant at example motors.');
  assert.deepEqual(good.typed, ['A fine truck. Sales consultant at example motors.'], 'a description that names the dealership is typed');
  assert.deepEqual(good.said, []);
  // the fields check view says why and keeps "Fill it in now" off
  assert.match(fnText('viewProbe'), /const blocked = fillBlocker\(state\.listing && state\.listing\.fields && state\.listing\.fields\.description\);/);
  assert.match(fnText('viewProbe'), /id="fillNow" \$\{found\.length && !cap\.reached && !blocked \? '' : 'disabled'\}/);
});

test('Open the Marketplace form does not open a tab for a description that does not name the dealership', async () => {
  const v = vehicle('usedNormal');
  const named = buildTemplateDescription({ vehicle: v, dealer: DEALER, salesperson: PAT_SC });
  const unnamed = named.replaceAll(DEALER.name, 'the lot');
  for (const probeOnly of [false, true]) {
    const stale = formOpener({ description: unnamed });
    await stale.fns.openForm({ probeOnly });
    assert.deepEqual(stale.forms, [], `no tab (${probeOnly ? 'check fields' : 'fill'})`);
    assert.ok(stale.calls.some((c) => c.startsWith("status(error): The description doesn't name Example Motors")), stale.calls.join(' | '));
  }
  const ok = formOpener({ description: named });
  await ok.fns.openForm();
  assert.equal(ok.forms.length, 1);
});

// ---------- a description that fails a fact or identity check is never typed into the form ----------
import * as template from '../extension/src/rewriteTemplate.js';

const CAR = { vin: '1TESTVEH0NA000123', year: 2021, make: 'Example', model: 'Sedan', trim: 'LX', name: '2021 Example Sedan LX', mileage: 34567, price: 20986, features: ['Heated Seats', 'Backup Camera', 'Bluetooth'], descriptionRaw: '' };
const SETTINGS = { dealer: { name: 'Example Motors', city: 'Springfield' }, salesperson: { name: 'Sam', title: 'sales consultant' }, priceNote: '' };
const CLEAN = template.buildTemplateDescription({ vehicle: CAR, dealer: SETTINGS.dealer, salesperson: SETTINGS.salesperson, priceNote: '' });
const CTX_LINE = constText('ctx');
const NOTE_LINE = constText('noteFor');
// sidepanel.js's own ctx and fillBlocker, over the real checks
function realBlocker(state) {
  return new Function('state', 'runGuardrails', 'ruleProblems', 'usableClosingLine', `${dealerChecks()}\n${NOTE_LINE}\n${CTX_LINE}\nreturn fillBlocker;`)(state, template.runGuardrails, template.ruleProblems, template.usableClosingLine);
}

test('the form is not filled with a description that fails a fact or identity check; length and tone only warn', () => {
  const state = { settings: SETTINGS, vehicle: CAR, price: 20986, noteApplies: true };
  const fillBlocker = realBlocker(state);
  assert.deepEqual(template.runGuardrails(CLEAN, { vehicle: CAR, dealer: SETTINGS.dealer, salesperson: SETTINGS.salesperson, price: 20986 }).problems, []);
  assert.equal(fillBlocker(CLEAN), '', 'the template is filled');
  const stops = {
    'an unknown number': CLEAN.replace('34,567 miles', '12,000 miles'),
    'a banned phrase': `${CLEAN}\nNo accidents.`,
    'a claim the website does not make': `${CLEAN}\nComes with a warranty.`,
    'one owner without the Carfax flag': `${CLEAN}\nOne owner.`,
    'no VIN': CLEAN.replace(/\nVIN .*$/m, ''),
    'no role': CLEAN.replace(', sales consultant at', ' at'),
    'a price that is not the listing\'s': `${CLEAN}\nYours for $18,995.`,
  };
  for (const [what, text] of Object.entries(stops)) {
    const why = fillBlocker(text);
    assert.match(why, /^The description fails (a check|\d+ checks) that must pass before the form is filled: /, what);
    assert.match(why, /Fix the description \(or use Reset to template\) first\.$/, what);
  }
  assert.match(fillBlocker(`${CLEAN}\nComes with a warranty.`), /Says "warranty", but the website says nothing about a warranty or guarantee for this car/);
  // the dealer's price note, when it applies to this car, is one of them
  const noted = { ...state, settings: { ...SETTINGS, priceNote: 'Tax and tags extra.' } };
  assert.match(realBlocker(noted)(CLEAN), /Doesn't include your dealership's price note/);
  assert.equal(realBlocker({ ...noted, noteApplies: false })(CLEAN), '', 'a note that does not apply to this car is not looked for');
  // length and tone are the salesperson's call
  for (const text of [`${CLEAN}\nCOME SEE THIS TRUCK TODAY`, `${CLEAN}\n🔥🔥🔥🔥`, CLEAN.split('\n').slice(0, 3).join('\n') + `\nI'm Sam, sales consultant at Example Motors.\nVIN ${CAR.vin}.`]) {
    const g = template.runGuardrails(text, { vehicle: CAR, dealer: SETTINGS.dealer, salesperson: SETTINGS.salesperson, price: 20986 });
    assert.equal(g.ok, false, text);
    assert.equal(fillBlocker(text), '', text);
  }
});

test('the checks line says which problems stop the form and which only warn', () => {
  const checksHtml = new Function('esc', 'ruleProblems', 'noteFor', `${fnText('checksHtml')}\nreturn checksHtml;`)((s) => String(s), template.ruleProblems, () => '');
  const stop = { code: 'unknown-number', text: '"12000" isn\'t in the website\'s data for this car' };
  const warn = { code: 'too-short', text: '50 words; needs at least 60' };
  const both = checksHtml({ ok: false, problems: [stop, warn], words: 50 });
  assert.match(both, /class="checks bad"/);
  assert.match(both, /Fix before the form can be filled:<ul><li>"12000" isn't in the website's data for this car<\/li><\/ul>/);
  assert.match(both, /Worth fixing \(the form can still be filled\):<ul><li>50 words; needs at least 60<\/li><\/ul>/);
  const warnOnly = checksHtml({ ok: false, problems: [warn], words: 50 });
  assert.match(warnOnly, /class="checks warn"/);
  assert.doesNotMatch(warnOnly, /Fix before/);
  assert.match(checksHtml({ ok: true, problems: [], words: 80 }), /^<div class="checks ok" id="checks">All checks passed: 80 words/);
  // passing says what was checked, no more: the claim checks go by set words
  const passed = checksHtml({ ok: true, problems: [], words: 80 });
  assert.doesNotMatch(passed, /claim matches the website/);
  assert.match(passed, /no banned phrases or flagged claims/);
  assert.match(passed, /read it through before you publish/);
});

test('Open the Marketplace form, Fill it in now and Fill again all refuse a description with a claim the website does not make', async () => {
  const v = vehicle('usedNormal');
  const ok = buildTemplateDescription({ vehicle: v, dealer: DEALER, salesperson: PAT_SC });
  const bad = `${ok}\nComes with a warranty.`;
  // openForm and the dry run's Fill it in now: no tab is opened and nothing filled, and the checks line is brought up to date
  for (const probeOnly of [false, true]) {
    const refused = formOpener({ description: bad });
    await refused.fns.openForm({ probeOnly });
    assert.deepEqual(refused.forms, []);
    assert.ok(refused.calls.some((c) => /^status\(error\): The description fails a check that must pass before the form is filled: Says "warranty"/.test(c)), refused.calls.join(' | '));
    assert.equal(refused.state.guardrails.ok, false, 'the checks line shows the problem');
  }
  const probe = formOpener({ description: bad, step: 'probe' });
  await probe.fns.fillFromProbe();
  assert.ok(!probe.calls.some((c) => c.startsWith('runFill')), 'Fill it in now does not fill');
  const opened = formOpener({ description: ok });
  await opened.fns.openForm();
  assert.equal(opened.forms.length, 1);
  // runFill: what Fill it in now (after a fields check) and Fill again call
  const typed = [];
  const said = [];
  const state = { settings: SETTINGS, vehicle: CAR, price: 20986, noteApplies: true, listing: { fields: { description: `${CLEAN}\nComes with a warranty.` } }, step: 'filling', map: { fields: [], photoLimitDefault: 20 } };
  const realCtx = new Function('state', 'usableClosingLine', `${NOTE_LINE}\n${CTX_LINE}\nreturn ctx;`)(state, template.usableClosingLine);
  const runFill = fillerFor(state, { said, typed, filled: never('saveFlow'), checks: [template.runGuardrails, template.ruleProblems, realCtx] });
  await runFill();
  assert.deepEqual(typed, []);
  assert.equal(state.step, 'review', 'back to the description');
  assert.match(said[0][0], /Says "warranty"/);
});

// ---------- the car is read again before a fill when the last read is old ----------
import * as rescan from '../extension/src/rescan.js';
import * as details from '../extension/src/vehicleDetails.js';
import * as normalize from '../extension/src/normalize.js';
import * as listingData from '../extension/src/listingData.js';
import * as vinModule from '../extension/src/vin.js';
import { vehicle as fixtureVehicle } from './helpers.js';

// carStillCurrent as sidepanel.js writes it (with readIsOld, readCarNow,
// takeCar and formValues), over the real checks, with the website read stubbed.
function staleReader(state, read) {
  const calls = { reads: 0, blocked: [], said: [], saved: 0 };
  const scope = {
    state, flowRun: 0, READ_MAX_AGE_MS,
    readCarForPost: async (req) => { calls.reads += 1; calls.req = req; return read(); },
    recheck: details.recheck,
    basisPrice: rescan.basisPrice,
    shortLocation: normalize.shortLocation,
    storeNames: normalize.storeNames,
    buildListingData: listingData.buildListingData,
    listingChanges: listingData.listingChanges,
    localVinCheck: vinModule.localVinCheck,
    runGuardrails: template.runGuardrails,
    ruleProblems: template.ruleProblems,
    usableClosingLine: template.usableClosingLine,
    pickedPhotos: () => (state.vehicle && state.vehicle.photos) || [],
    block: async (message, code) => { calls.blocked.push(code); state.step = 'blocked'; state.message = message; },
    setStatus: (text, tone) => calls.said.push([text, tone]),
    render: () => {},
    saveFlow: async () => { calls.saved += 1; },
  };
  const fns = compileMany(['carStillCurrent', 'readIsOld', 'readCarNow', 'takeCar', 'formValues'], scope, ['money', 'ctx', 'noteFor']);
  return { run: fns.carStillCurrent, calls };
}

const FRESH_CAR = () => fixtureVehicle('usedNormal'); // pre-owned, ready, 27163 / 26673, 20,986 miles
const reviewState = (extra = {}) => {
  const v = FRESH_CAR();
  return {
    origin: 'https://www.example-dealer.test', vin: v.vin, dealerTabId: 7, siteInfo: null, snapshotVehicles: {}, snapshotTakenAt: null,
    settings: { ...SETTINGS, basis: 'website', myStores: [], defaults: { titleStatus: 'Clean', condition: 'Very good' } },
    vehicle: v, price: 27163, noteApplies: true, description: template.buildTemplateDescription({ vehicle: v, dealer: SETTINGS.dealer, salesperson: SETTINGS.salesperson, priceNote: '' }),
    step: 'review', colorGuess: null, vinCheck: null, listing: { fields: {} }, photoPick: null, map: FORM_MAP,
    ...extra,
  };
};

test('a post whose car was read a while ago (or before the panel was closed) reads it again before the form is filled', async () => {
  // read just now (the queue opens the form straight after reading): not read twice
  const now = staleReader(reviewState({ readAt: new Date().toISOString() }), () => { throw new Error('read'); });
  assert.equal(await now.run(), true);
  assert.equal(now.calls.reads, 0);

  // a flow saved before reads were timed, or one left at review for days: read again; unchanged, the fill goes on
  for (const readAt of [undefined, null, new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString()]) {
    const state = reviewState({ readAt });
    const same = staleReader(state, () => ({ ok: true, vehicle: FRESH_CAR() }));
    assert.equal(await same.run(), true, String(readAt));
    assert.equal(same.calls.reads, 1);
    assert.deepEqual([same.calls.req.vin, same.calls.req.origin, same.calls.req.tabId], [state.vin, state.origin, 7]);
    assert.ok(Date.now() - Date.parse(state.readAt) < 1000, 'the read is timed');
    assert.equal(state.step, 'review');
  }

  // the website dropped the price meanwhile: back to the review with the new price, nothing filled
  const state = reviewState({ readAt: new Date(Date.now() - 3600 * 1000).toISOString(), step: 'filling' });
  const dropped = staleReader(state, () => ({ ok: true, vehicle: { ...FRESH_CAR(), price: 26163, priceBeforeFees: 25673 } }));
  assert.equal(await dropped.run(), false);
  assert.equal(state.step, 'review');
  assert.equal(state.price, 26163);
  assert.equal(state.vehicle.price, 26163);
  assert.equal(state.listing, null, 'the listing is built again from the new read');
  assert.match(dropped.calls.said.at(-1)[0], /^The website changed this car since it was read \(price \$27,163 to \$26,163\)\./);
  assert.equal(dropped.calls.said.at(-1)[1], 'error');
  assert.ok(dropped.calls.saved >= 1);

  // a new mileage: back to the review, and the description's old mileage now fails its check
  const miles = reviewState({ readAt: '', description: '2019 Ram 1500 Classic Express with 20,986 miles.' });
  const moved = staleReader(miles, () => ({ ok: true, vehicle: { ...FRESH_CAR(), mileage: 21500 } }));
  assert.equal(await moved.run(), false);
  assert.match(moved.calls.said.at(-1)[0], /The website changed this car since it was read \(mileage\)/);
  assert.ok(miles.guardrails.problems.some((p) => p.code === 'mileage-mismatch'));
});

test('a car that sold, went sale-pending, turned new or lost its price since it was read is stopped before the form is filled', async () => {
  const cases = [
    [() => ({ ok: false, notFound: true, message: 'Not on the website any more.' }), 'not-on-website'],
    [() => ({ ok: false, message: 'The website did not answer.' }), 'site-unreachable'],
    [() => ({ ok: false, needsPermission: true, origins: ['https://www.example-dealer.test/*'], message: 'Allow reading.' }), 'no-permission'],
    [() => ({ ok: true, vehicle: { ...FRESH_CAR(), status: 'pend-sale' } }), 'check-not-ready'],
    [() => ({ ok: true, vehicle: { ...FRESH_CAR(), inventoryType: 'New', urlConditionWord: 'new', siteTitle: 'New 2019 Ram 1500 Classic Express' } }), 'check-skip'],
    [() => ({ ok: true, vehicle: { ...FRESH_CAR(), price: null, priceBeforeFees: null } }), 'check-not-ready'],
  ];
  for (const [read, code] of cases) {
    const state = reviewState({ readAt: null });
    const r = staleReader(state, read);
    assert.equal(await r.run(), false, code);
    assert.deepEqual(r.calls.blocked, [code]);
    assert.equal(state.step, 'blocked');
    if (code === 'no-permission') assert.deepEqual(state.blockedOrigins, ['https://www.example-dealer.test/*']);
  }
});

test('Open the Marketplace form and every fill read the car again first; a post started now records when it read the car', async () => {
  assert.match(fnText('openForm'), /if \(descriptionStopped\(\)\) return undefined;\n\s*if \(!\(await carStillCurrent\(\)\) \|\| dropped\(\)\) return undefined;/);
  assert.match(fnText('descriptionStopped'), /const why = fillBlocker\(state\.description\);/);
  assert.match(fnText('fillFromProbe'), /if \(descriptionStopped\(\)\) return undefined;\n\s*if \(!\(await carStillCurrent\(\)\)\) return undefined;\n\s*return runFill\(\);/);
  assert.match(fnText('runFill'), /if \(!\(await carStillCurrent\(\)\) \|\| run !== flowRun \|\| state\.fbTabId !== tabId\) return undefined;\n\s*const blocked = fillBlocker\(listing && listing\.fields && listing\.fields\.description\);/);
  assert.match(fnText('startFlow'), /const car = await readCarNow\(\);[\s\S]*takeCar\(car\);/);
  assert.match(fnText('readCarNow'), /readAt: new Date\(\)\.toISOString\(\)/);
  assert.match(fnText('takeCar'), /state\.readAt = car\.readAt;/);
  assert.match(src, /^const FLOW_FIELDS = \[[^\]]*'readAt'/m);
  assert.match(fnText('clearFlow'), /readAt: null/);
  // a read that took the panel back to the review (or stopped the post) opens no form and types nothing
  const state = { origin: 'https://www.example-dealer.test', vin: 'AAA', settings: SETTINGS, vehicle: CAR, price: 20986, noteApplies: true, description: CLEAN, posted: {}, syncState: null, listing: { fields: { description: CLEAN } }, step: 'probe', map: { fields: [] } };
  const openForm = compile('openForm', {
    state, flowRun: 0, readStoredCounts: async () => true, stopPosted: never('stopPosted'), dailyCap: () => ({ reached: false }), capCount, setStatus: never('setStatus'),
    descriptionStopped: () => false, carStillCurrent: async () => false, buildListingData: never('buildListingData'),
  });
  assert.equal(await openForm(), undefined);
  assert.equal(state.opening, false);
  const said = [];
  const typed = [];
  const runFill = fillerFor(state, { said, typed, current: async () => false, checks: [never('runGuardrails'), never('ruleProblems'), never('ctx')] });
  assert.equal(await runFill(), undefined);
  assert.deepEqual([said, typed], [[], []]);
});

test('one click on Open the Marketplace form opens one form: a second click while the checks run, or once the form is open, does nothing', async () => {
  const v = vehicle('usedNormal');
  const description = buildTemplateDescription({ vehicle: v, dealer: DEALER, salesperson: PAT_SC });
  let release = null;
  let reads = 0;
  // the car read again (its last read is an hour old): the read is a trip to the website
  const o = formOpener({
    description, readAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    read: () => { reads += 1; return new Promise((resolve) => { release = () => resolve({ ok: true, vehicle: { ...v } }); }); },
  });
  const first = o.fns.openForm();
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 1, 'the first click is reading the car again');
  assert.equal(o.state.opening, true);
  assert.equal(await o.fns.openForm(), undefined, 'a second click meanwhile does nothing');
  assert.equal(reads, 1);
  release();
  await first;
  assert.deepEqual([o.forms.length, o.state.step, o.state.opening], [1, 'filling', false], 'one listing built, one form opening');
  assert.equal(await o.fns.openForm(), undefined, 'a click that lands once the form is opening does nothing');
  o.state.step = 'publish';
  assert.equal(await o.fns.openForm(), undefined, 'nor once it is filled');
  assert.deepEqual([reads, o.forms.length], [1, 1]);
  // a click whose checks stopped it leaves the button working
  const stopped = formOpener({ description: description.replaceAll(DEALER.name, 'the lot') });
  await stopped.fns.openForm();
  assert.deepEqual([stopped.forms.length, stopped.state.opening], [0, false]);
  stopped.box.value = description; // fixed in the box
  await stopped.fns.openForm();
  assert.equal(stopped.forms.length, 1, 'the next click opens the form');
});

// ---------- a colour guessed from the photos goes on the form, never into the description ----------
import * as rewriter from '../extension/src/rewriter.js';

// A top-level function compiled with the given scope, plus the panel's own
// top-level helpers it calls that the scope does not stub, compiled from the source too.
function compileWithOwnHelpers(name, scope) {
  const own = [...new Set([...fnText(name).matchAll(/\b([A-Za-z_]\w*)\(/g)].map((m) => m[1]))]
    .filter((n) => n !== name && !(n in scope) && new RegExp(`^(async )?function ${n}\\(`, 'm').test(src));
  const names = Object.keys(scope);
  return new Function(...names, `${own.map(fnText).join('\n')}\n${fnText(name)}\nreturn ${name};`)(...names.map((n) => scope[n]));
}

test('a colour guessed from the photos goes on the form, never into the description', async () => {
  const car = { ...CAR, exteriorColor: '', interiorColor: '' }; // the website gives no colour
  const guess = { exterior: 'Gray', interior: 'Black', confidence: 'low' };
  const written = async (rewrite) => {
    const seen = [];
    const state = { settings: { ...SETTINGS, rewrite }, vehicle: car, price: 20986, noteApplies: true, colorGuess: guess, boilerplate: [], origin: 'https://www.example-dealer.test', highlights: null };
    const generate = compileWithOwnHelpers('generate', {
      state,
      rewriteWithKey: async (rw) => rw,
      generateDescription: (args) => {
        seen.push(args.vehicle);
        return rewriter.generateDescription({ ...args, fetchImpl: async (_url, init) => { seen.push(JSON.parse(init.body)); return { ok: false, status: 503, json: async () => ({}) }; } });
      },
      noteFor: () => '',
      settleHighlights: template.settleHighlights,
      LAPSED_MESSAGE: 'lapsed', LAPSED_SENTENCE: 'Lapsed',
      flowRun: 0,
    });
    await generate();
    return { seen, description: state.description };
  };
  for (const rewrite of [{ enabled: false }, { enabled: true, endpoint: 'https://rewrite.example.test', key: 'k' }]) {
    const { seen, description } = await written(rewrite);
    assert.equal(seen.length, rewrite.enabled ? 2 : 1, 'the writer ran, and with the service on the facts went to it');
    for (const facts of seen) {
      assert.equal(facts.exteriorColor || '', '', `the writer is given the website's exterior colour only (${rewrite.enabled ? 'rewrite service' : 'template'})`);
      assert.equal(facts.interiorColor || '', '', `the writer is given the website's interior colour only (${rewrite.enabled ? 'rewrite service' : 'template'})`);
    }
    assert.doesNotMatch(description, /\bGray\b|\bBlack\b/, 'the guess is not stated in the description');
  }
  // the guess still goes on the form's colour fields, listed as assumed with its confidence
  const listing = listingData.buildListingData(car, { guesses: guess, price: 20986 });
  assert.deepEqual([listing.fields.exteriorColor, listing.fields.interiorColor], ['Gray', 'Black']);
  assert.match(listing.assumed.find((a) => a.key === 'exteriorColor').why, /guessed from the photos \(low confidence\)/);
  // "Guess from the photos" changes the form's colours only: it does not rewrite the description (or the person's edits to it)
  const click = src.slice(src.indexOf("case 'guessColors':"), src.indexOf('case ', src.indexOf("case 'guessColors':") + 5));
  assert.ok(click.includes('maybeGuessColors(true)'), 'the click asks for a guess');
  assert.doesNotMatch(click, /\bgenerate\(/, 'the click does not write the description again');
});
