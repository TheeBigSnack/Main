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
  const startFlow = compile('startFlow', {
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
function formOpener({ description, step = 'review', readAt = new Date().toISOString(), read = null, car = vehicle('usedNormal'), also = [], autoOpen = false, gen = null, tabLoad = null }) {
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
  const fns = compileMany(['resumeFlow', 'descriptionStopped', 'readIsOld', 'readCarNow', 'takeCar', 'formValues', 'carStillCurrent', 'openForm', 'fillFromProbe', ...also], {
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
    siteKeys: (o) => ({ posted: 'posted:' + o, sync: 'sync:' + o, flow: 'postFlow:' + o }),
    dailyCap: () => ({ reached: false, used: 0, cap: 10 }),
    pickedPhotos: () => [],
    render: () => calls.push('render:' + state.step), saveFlow: async () => {}, pilotNote: async () => {}, notePostStep: () => {},
    GLOBAL_KEYS: { devOverrides: 'devOverrides', postRequest: 'postRequest' }, FORM_MAP, applyOverrides: (m) => m,
    chrome: { storage: { local: { get: async () => ({}), remove: async () => {} } }, tabs: { create: async () => { calls.push('tabs.create'); forms.push(`${state.vehicle ? state.vehicle.vin : '(no car)'} while vin=${state.vin}`); return { id: 77 }; } } },
    waitForTabLoad: async (id) => (tabLoad ? tabLoad(id) : undefined), sleep: async () => {},
    runFill: async () => calls.push(`runFill: ${state.listing ? state.listing.fields.description : '(no listing)'}`),
    runProbe: async () => calls.push('runProbe'),
    readCarForPost: async (req) => {
      calls.push(`readCarForPost ${req.vin} tab ${req.tabId}`);
      return (read || never('readCarForPost'))(req);
    },
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
    const fns = compileMany(['runFill', 'attachPhotos', 'clearFlow'], {
      state, flowRun: 0, watcher: null, FORM_MAP, VERSION: '0.0.0',
      fillFormInPage: () => {}, attachPhotosInPage: () => {},
      chrome: {
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
    const state = { origin: 'o', vin: 'AAA', vehicle: { vin: 'AAA', name: 'Car A', price: 20000 }, settings: { basis: 'website', salesperson: { name: 'Pat' } }, detected: null, queueMode: false, posted: {}, postLog: [] };
    const confirmPosted = compile('confirmPosted', {
      state, $: () => null, watcher: null,
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
