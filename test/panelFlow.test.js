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
import { currentVin } from '../extension/src/queue.js';
import { runGuardrails, ruleProblems, buildTemplateDescription } from '../extension/src/rewriteTemplate.js';
import { buildListingData } from '../extension/src/listingData.js';
import { recheck } from '../extension/src/vehicleDetails.js';
import { basisPrice } from '../extension/src/rescan.js';
import { shortLocation, storeNames } from '../extension/src/normalize.js';
import { localVinCheck } from '../extension/src/vin.js';
import { FORM_MAP } from '../extension/facebook/formMap.js';
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

// Opening the form, compiled with sidepanel.js's own checks and the real
// guardrails and listing builder; the tab, the fill and the probe are stubs
// that record they were reached. `description` is what the box holds.
const DEALER = { name: 'Example Motors', city: 'Exampletown', state: 'PA', zip: '15000' };
const READ_MAX_AGE_MS = Number(new Function(`return ${/const READ_MAX_AGE_MS = ([^;]+);/.exec(src)[1]}`)());
const FLOW_FIELDS = new Function(`return ${/const FLOW_FIELDS = (\[[^\]]*\]);/.exec(src)[1]}`)();
function formOpener({ description, step = 'review', readAt = new Date().toISOString(), read = null, car = vehicle('usedNormal') }) {
  const v = car;
  const calls = [];
  const box = { value: description };
  const state = {
    origin: 'https://www.example-motors.test', vin: v.vin, step, vehicle: v, price: v.price, noteApplies: true, readAt,
    description, settings: { dealer: DEALER, defaults: {}, basis: 'website', priceNote: '', salesperson: { name: 'Pat', title: 'sales consultant', closingLine: '' }, dailyCap: 10 },
    posted: {}, colorGuess: null, listing: null, snapshotVehicles: {}, siteInfo: null, dealerTabId: 41, map: FORM_MAP, photoPick: null,
  };
  const ctx = () => ({ vehicle: state.vehicle, dealer: state.settings.dealer, priceNote: '', price: state.price, closingLine: '' });
  // the dry run built the listing when it opened the form
  if (step === 'probe') state.listing = buildListingData(v, { dealer: DEALER, description, price: v.price, photos: [] });
  const fns = compileMany(['resumeFlow', 'descriptionStopped', 'readIsOld', 'readCarNow', 'takeCar', 'formValues', 'carStillCurrent', 'openForm', 'fillFromProbe'], {
    state, ctx, runGuardrails, ruleProblems, buildListingData, READ_MAX_AGE_MS, FLOW_FIELDS,
    loadSaved: async () => true, startWatcher: () => calls.push('startWatcher'),
    recheck, basisPrice, shortLocation, storeNames, localVinCheck, money: (n) => '$' + n.toLocaleString('en-US'),
    block: async (message, code) => {
      calls.push('block: ' + code);
      Object.assign(state, { step: 'blocked', message });
    },
    $: (id) => (id === 'description' && step === 'review' ? box : null),
    checksHtml: () => '', setFormButtons: () => calls.push('buttons'),
    setStatus: (text, kind) => calls.push(`status${kind ? '(' + kind + ')' : ''}: ${text}`),
    siteKeys: (o) => ({ posted: 'posted:' + o, sync: 'sync:' + o }),
    dailyCap: () => ({ reached: false, used: 0, cap: 10 }),
    pickedPhotos: () => [],
    render: () => calls.push('render:' + state.step), saveFlow: async () => {}, pilotNote: async () => {}, notePostStep: () => {},
    GLOBAL_KEYS: { devOverrides: 'devOverrides' }, FORM_MAP, applyOverrides: (m) => m,
    chrome: { storage: { local: { get: async () => ({}) } }, tabs: { create: async ({ url }) => { calls.push('tabs.create'); return { id: 77 }; } } },
    waitForTabLoad: async () => {}, sleep: async () => {},
    runFill: async () => calls.push(`runFill: ${state.listing.fields.description}`),
    runProbe: async () => calls.push('runProbe'),
    readCarForPost: async (req) => {
      calls.push(`readCarForPost ${req.vin} tab ${req.tabId}`);
      return (read || never('readCarForPost'))(req);
    },
  });
  return { state, calls, fns, v };
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
  const nothing = requestPanel({ step: 'idle', vin: null });
  await nothing.fns.resumeOpenForm(undefined);
  assert.deepEqual(nothing.calls, []);

  // the queue bar: a single post's form open, so no Post next car
  const queue = { vins: ['BBB', 'CCC'], index: 0, status: 'running' };
  for (const step of ['filling', 'probe', 'publish']) assert.doesNotMatch(requestPanel({ step, queue }).fns.queueBar(), /queueNext/, step);
  assert.match(requestPanel({ step: 'review', queue }).fns.queueBar(), /id="queueNext"/);
  assert.match(requestPanel({ step: 'idle', vin: null, queue }).fns.queueBar(), /id="queueNext"/);
});
