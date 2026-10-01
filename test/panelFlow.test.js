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

test('the Marketplace form is not opened while no dealership name is set: no description could name the dealership', async () => {
  const consts = ['dealerNamed', 'NO_DEALER_TEXT'].map((n) => {
    const m = src.match(new RegExp(`^const ${n} = .*;$`, 'm'));
    assert.ok(m, `${n} is defined`);
    return m[0];
  }).join('\n');
  const run = async (dealer, options) => {
    const said = [];
    const openForm = new Function('state', 'setStatus', 'siteKeys', `${consts}\n${fnText('openForm')}\nreturn openForm;`)(
      { settings: { dealer } },
      (text, tone) => said.push([text, tone]),
      never('siteKeys'), // the first step past the check
    );
    try {
      await openForm(options);
      return { said, opened: false };
    } catch (e) {
      assert.match(e.message, /siteKeys must not run/);
      return { said, opened: true };
    }
  };
  for (const dealer of [{ name: '' }, { name: '   ' }, {}]) {
    const r = await run(dealer);
    assert.equal(r.opened, false, JSON.stringify(dealer));
    assert.deepEqual(r.said, [["Add your dealership's name in Settings first (Dealership name): every description names the dealership.", 'error']]);
  }
  assert.equal((await run({ name: 'Example Motors' })).opened, true, 'with a name the form opens');
  assert.equal((await run({ name: '' }, { probeOnly: true })).opened, true, 'checking the form fills nothing, so it still opens');
  // the review step shows why and keeps the button off
  assert.match(fnText('viewReview'), /id="openForm" \$\{cap\.reached \|\| !dealerNamed\(\) \? 'disabled' : ''\}/);
});

test('the panel checks every description against the salesperson\'s own role', () => {
  // the checks' context carries the salesperson, so their title from Settings is the role looked for
  assert.match(src, /^const ctx = \(\) => \(\{[^\n]*\bsalesperson: state\.settings\.salesperson\b/m);
});

// The rest of the checks, passing, for the tests about the dealership's name
// alone (fillBlocker runs them after the name; the tests further down run the real ones).
const PASSING_CHECKS_NAMES = ['runGuardrails', 'blockingProblems', 'ctx'];
const PASSING_CHECKS = [() => ({ ok: true, problems: [], words: 80 }), (g) => g.problems, () => ({})];

// dealerNamed and NO_DEALER_TEXT as sidepanel.js writes them, with fillBlocker when it is defined.
function dealerChecks() {
  const consts = ['dealerNamed', 'NO_DEALER_TEXT'].map((n) => {
    const m = src.match(new RegExp(`^const ${n} = .*;$`, 'm'));
    assert.ok(m, `${n} is defined`);
    return m[0];
  });
  return [...consts, /function fillBlocker\(/.test(src) ? fnText('fillBlocker') : ''].join('\n');
}

test('no way of filling the form types a description that does not name the dealership', async () => {
  const NO_NAME = "Add your dealership's name in Settings first (Dealership name): every description names the dealership.";
  // runFill is what "Fill it in now" (after a fields check) and "Fill again" call
  const fill = async (dealer, description, step = 'probe') => {
    const said = [];
    const typed = [];
    const state = { settings: { dealer }, listing: { fields: { description } }, step, map: { fields: [], photoLimitDefault: 20 } };
    const runFill = new Function('state', 'setStatus', 'render', 'chrome', 'saveFlow', 'fillFormInPage', ...PASSING_CHECKS_NAMES, `${dealerChecks()}\n${fnText('runFill')}\nreturn runFill;`)(
      state,
      (text, tone) => said.push([text, tone]),
      () => {},
      { scripting: { executeScript: async (inj) => { typed.push(inj.args[1].fields.description); return [{ result: {} }]; } } },
      async () => { throw new Error('filled'); }, // the first step after the form is filled
      function fillFormInPage() {},
      ...PASSING_CHECKS,
    );
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
  assert.match(fnText('viewProbe'), /id="fillNow" \$\{found\.length && !blocked \? '' : 'disabled'\}/);
});

test('Open the Marketplace form does not open a tab for a description that does not name the dealership', async () => {
  const open = async (description, probeOnly = false) => {
    const said = [];
    const state = { origin: 'https://www.example-dealer.test', settings: { dealer: { name: 'Example Motors' } }, description, posted: {}, syncState: null };
    const openForm = new Function('state', 'setStatus', 'siteKeys', 'chrome', 'dailyCap', '$', 'checksHtml', 'buildListingData', 'pickedPhotos', ...PASSING_CHECKS_NAMES, `${dealerChecks()}\n${fnText('openForm')}\nreturn openForm;`)(
      state,
      (text, tone) => said.push([text, tone]),
      () => ({ posted: 'p', sync: 's' }),
      { storage: { local: { get: async () => ({}) } } },
      () => ({ reached: false }),
      () => null,
      () => '',
      never('buildListingData'), // the next step: the listing is built for the form
      never('pickedPhotos'),
      ...PASSING_CHECKS,
    );
    try {
      await openForm({ probeOnly });
      return { said, opened: false };
    } catch (e) {
      assert.match(e.message, /(buildListingData|pickedPhotos) must not run/);
      return { said, opened: true };
    }
  };
  const stale = await open('A fine truck. Sales consultant.');
  assert.equal(stale.opened, false);
  assert.match(stale.said[0][0], /^The description doesn't name Example Motors/);
  assert.equal((await open('A fine truck. Sales consultant at Example Motors.')).opened, true);
  assert.equal((await open('A fine truck. Sales consultant.', true)).opened, true, 'checking the form fills nothing, so it still opens');
});

// ---------- a description that fails a fact or identity check is never typed into the form ----------
import * as template from '../extension/src/rewriteTemplate.js';

const CAR = { vin: '1TESTVEH0NA000123', year: 2021, make: 'Example', model: 'Sedan', trim: 'LX', name: '2021 Example Sedan LX', mileage: 34567, price: 20986, features: ['Heated Seats', 'Backup Camera', 'Bluetooth'], descriptionRaw: '' };
const SETTINGS = { dealer: { name: 'Example Motors', city: 'Springfield' }, salesperson: { name: 'Sam', title: 'sales consultant' }, priceNote: '' };
const CLEAN = template.buildTemplateDescription({ vehicle: CAR, dealer: SETTINGS.dealer, salesperson: SETTINGS.salesperson, priceNote: '' });
// sidepanel.js's own ctx and fillBlocker, over the real checks
function realBlocker(state) {
  const ctxLine = src.match(/^const ctx = .*;$/m)[0];
  const noteLine = src.match(/^const noteFor = .*;$/m)[0];
  return new Function('state', 'runGuardrails', 'blockingProblems', 'usableClosingLine', `${dealerChecks()}\n${noteLine}\n${ctxLine}\nreturn fillBlocker;`)(state, template.runGuardrails, template.blockingProblems, template.usableClosingLine);
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
  const checksHtml = new Function('esc', 'blockingProblems', 'noteFor', `${fnText('checksHtml')}\nreturn checksHtml;`)((s) => String(s), template.blockingProblems, () => '');
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
});

test('Open the Marketplace form, Fill it in now and Fill again all refuse a description with a claim the website does not make', async () => {
  const bad = `${CLEAN}\nComes with a warranty.`;
  const ctxLine = src.match(/^const ctx = .*;$/m)[0];
  const noteLine = src.match(/^const noteFor = .*;$/m)[0];
  const checks = [template.runGuardrails, template.blockingProblems, template.usableClosingLine];
  // openForm: no tab is opened, and the checks line is brought up to date
  const opened = async (description) => {
    const said = [];
    const state = { origin: 'https://www.example-dealer.test', settings: SETTINGS, vehicle: CAR, price: 20986, noteApplies: true, description, posted: {}, syncState: null };
    const openForm = new Function('state', 'setStatus', 'siteKeys', 'chrome', 'dailyCap', '$', 'checksHtml', 'buildListingData', 'pickedPhotos', 'runGuardrails', 'blockingProblems', 'usableClosingLine', `${dealerChecks()}\n${noteLine}\n${ctxLine}\n${fnText('openForm')}\nreturn openForm;`)(
      state, (text, tone) => said.push([text, tone]), () => ({ posted: 'p', sync: 's' }), { storage: { local: { get: async () => ({}) } } }, () => ({ reached: false }), () => null, () => '',
      never('buildListingData'), never('pickedPhotos'), ...checks,
    );
    try {
      await openForm();
      return { said, opened: false, state };
    } catch (e) {
      assert.match(e.message, /(buildListingData|pickedPhotos) must not run/);
      return { said, opened: true, state };
    }
  };
  const refused = await opened(bad);
  assert.equal(refused.opened, false);
  assert.match(refused.said[0][0], /^The description fails a check that must pass before the form is filled: Says "warranty"/);
  assert.equal(refused.state.guardrails.ok, false, 'the checks line shows the problem');
  assert.equal((await opened(CLEAN)).opened, true);
  // runFill: what Fill it in now (after a fields check) and Fill again call
  const typed = [];
  const state = { settings: SETTINGS, vehicle: CAR, price: 20986, noteApplies: true, listing: { fields: { description: bad } }, step: 'filling', map: { fields: [], photoLimitDefault: 20 } };
  const said = [];
  const runFill = new Function('state', 'setStatus', 'render', 'chrome', 'saveFlow', 'fillFormInPage', 'runGuardrails', 'blockingProblems', 'usableClosingLine', `${dealerChecks()}\n${noteLine}\n${ctxLine}\n${fnText('runFill')}\nreturn runFill;`)(
    state, (text, tone) => said.push([text, tone]), () => {}, { scripting: { executeScript: async (inj) => { typed.push(inj.args[1].fields.description); return [{ result: {} }]; } } }, never('saveFlow'), function fillFormInPage() {}, ...checks,
  );
  await runFill();
  assert.deepEqual(typed, []);
  assert.equal(state.step, 'review', 'back to the description');
  assert.match(said[0][0], /Says "warranty"/);
});
