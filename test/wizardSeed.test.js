// The set-up wizard (extension/wizard.js) starts from what is already there:
// this website's own settings, else the person's synced profile. Starting
// from defaults instead put them over a working install the moment the
// website was read, even when the person quit straight after (the cap back
// to 10, the price basis and the rescans reset, the rewrite key gone), and
// Finish set-up wrote them over the synced profile.
//
// The wizard is driven here as the side panel drives it: its clicks go
// through handleWizardClick, the website is the Dealer Inspire look-alike
// page from test/helpers.js, and the inputs a step reads are the ones its
// own HTML drew, left as they were (a person clicking Next).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures, fakeDealerPage, fakeChrome, vehicle, snapshot, MY_STORE, WAYNESBURG } from './helpers.js';
import { wiz, wizardHtml, startWizard, handleWizardClick, handleWizardChange, TAB_GONE } from '../extension/wizard.js';
import { STORAGE_FULL } from '../extension/src/storage.js';
import { settingNumberWarning } from '../extension/src/rewriteTemplate.js';
import { withDefaults, PROFILE_KEY } from '../extension/src/settings.js';
import { siteKeys, SITES_KEY } from '../extension/src/storageKeys.js';

const ORIGIN = 'https://example-dealer.test';
const RECORDS = Object.entries(fixtures).filter(([k]) => k !== '_about').map(([, r]) => r);
const k = siteKeys(ORIGIN);

// What a website holds after weeks of use through the popup, set-up never run.
const STORED = {
  ...MY_STORE,
  basis: 'beforeFees',
  priceNote: 'Price is before the doc fee; tax and tags extra.',
  dailyCap: 5,
  salesperson: { name: 'Sam', title: 'sales manager', closingLine: 'Ask for me by name when you come in.' },
  dealer: { name: 'Example Motors', city: 'Springfield', state: 'OH', zip: '43215' },
  rewrite: { enabled: true, endpoint: 'https://rewrite.example-backend.test', key: 'typed-service-key' },
  defaults: { titleStatus: '', condition: 'Good' },
  autoRescan: true,
  notify: false,
  legal: { version: 'v1', acceptedAt: '2026-09-29T12:00:00.000Z' },
  readySort: 'price',
  newDays: 14,
};

// The person's synced profile (src/settings.js profileFrom), saved on `origin`.
const profile = (origin) => ({
  origin,
  salesperson: { name: 'Sam', title: 'sales manager', closingLine: 'Ask for me by name when you come in.' },
  dealer: { name: 'Example Motors', city: 'Springfield', state: 'OH', zip: '43215' },
  myStores: [],
  basis: 'website',
  priceNote: 'Tax and tags extra.',
  dailyCap: 5,
  defaults: { titleStatus: '', condition: 'Good' },
  rewrite: { enabled: true, endpoint: 'https://rewrite.example-backend.test' },
  legal: { version: 'v1', acceptedAt: '2026-09-29T12:00:00.000Z' },
  savedAt: '2026-09-30T00:00:00.000Z',
});

// chrome for the wizard: local and sync storage, no tab addresses, and the
// rescan permission held for the origins in `granted` (never asked for here).
function browser({ local = {}, sync = {}, granted = [], records = RECORDS } = {}) {
  const page = fakeDealerPage({ records, origin: ORIGIN, name: 'Example Motors' });
  const chrome = fakeChrome(page, local);
  chrome.storage.local.remove = async (keys) => { for (const key of [].concat(keys)) delete local[key]; };
  chrome.storage.sync = {
    get: async (key) => (key in sync ? { [key]: structuredClone(sync[key]) } : {}),
    set: async (obj) => { Object.assign(sync, structuredClone(obj)); },
  };
  chrome.tabs = { query: async () => [] };
  chrome.runtime = { sendMessage: async () => ({}) };
  const asked = [];
  chrome.permissions = {
    contains: async ({ origins }) => origins.every((o) => granted.some((g) => o.startsWith(g))),
    request: async (req) => { asked.push(req); return false; },
  };
  globalThis.chrome = chrome;
  return { local, sync, asked };
}

// The side panel's document, as far as the wizard reads it: the inputs the
// last render drew, with the values and ticks it gave them.
let html = '';
const unesc = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
function inputs() {
  return [...html.matchAll(/<input\b([^>]*)>/g)].map(([, a]) => {
    const attr = (n) => { const m = new RegExp(`\\b${n}="([^"]*)"`).exec(a); return m ? unesc(m[1]) : undefined; };
    return { id: attr('id'), name: attr('name'), className: attr('class'), value: attr('value') ?? '', checked: /\schecked\b/.test(a) };
  });
}
globalThis.document = {
  getElementById: (id) => inputs().find((i) => i.id === id) || null,
  querySelectorAll: (sel) => (sel === '.wizStore:checked' ? inputs().filter((i) => i.className === 'wizStore' && i.checked) : []),
  querySelector: (sel) => {
    const m = /^input\[name="([^"]+)"\]:checked$/.exec(sel);
    return m ? inputs().find((i) => i.name === m[1] && i.checked) || null : null;
  },
};
const ctx = { render: () => { html = wizardHtml(); }, setStatus() {}, onClose() {} };

async function start() {
  await startWizard({ origin: ORIGIN, dealerTabId: 3, windowId: 1 });
  ctx.render();
}
async function nextUntil(step) {
  for (let i = 0; wiz.step !== step; i++) {
    assert.ok(i < 20, `never reached the ${step} step`);
    await handleWizardClick('wizNext', ctx);
    assert.equal(wiz.error, '', `the wizard stopped: ${wiz.error}`);
  }
}

test('set-up started and quit on a website that has settings leaves them, the rescans and the posted prices as they were', async () => {
  const ram = vehicle('usedNormal');
  assert.ok(ram.priceBeforeFees < ram.price, 'the fixture shows a lower second price');
  const posted = { [ram.vin]: { name: ram.name, price: ram.priceBeforeFees, postedAt: '2026-09-28T15:00:00.000Z' } };
  const { local } = browser({
    local: { [k.settings]: structuredClone(STORED), [k.posted]: posted, [SITES_KEY]: { [ORIGIN]: { name: 'Example Motors', auto: true } } },
    granted: [ORIGIN],
  });
  await start();
  await handleWizardClick('wizNext', ctx); // Start: the website is read at once
  assert.equal(wiz.step, 'scan');
  assert.ok(wiz.scan && wiz.scan.cars > 0, 'the website was read');
  await handleWizardClick('wizQuit', ctx);

  assert.deepEqual(local[k.settings], withDefaults(STORED), 'the website\'s settings are as they were: cap, basis, price note, closing line, listing defaults, rewrite key, rescans, Terms, list order');
  assert.equal(local[SITES_KEY][ORIGIN].auto, true, 'background rescans stay on');
  assert.deepEqual((local[k.diff].priceUpdates || []).filter((p) => p.vin === ram.vin), [], 'a car posted at the lower second price is not flagged for a price change that never happened');
});

test('set-up run to the end on a website that has settings keeps them, and Skip for now leaves rescans that are allowed on', async () => {
  const { local, sync, asked } = browser({
    local: { [k.settings]: structuredClone(STORED), [SITES_KEY]: { [ORIGIN]: { name: 'Example Motors', auto: true } } },
    granted: [ORIGIN],
  });
  await start();
  await nextUntil('store');
  assert.match(html, /your earlier choice is ticked/, 'the store hint says the choice is the saved one');
  await nextUntil('you');
  assert.equal(document.getElementById('wizName').value, 'Sam', 'the You step shows the name already saved');
  await nextUntil('permission');
  assert.match(html, /Automatic rescans are on/, 'the Permission step says rescans are on');
  await nextUntil('terms');
  await handleWizardClick('wizFinish', ctx);
  assert.equal(wiz.step, 'done', wiz.error);
  assert.deepEqual(asked, [], 'Chrome was never asked for a permission');

  const s = local[k.settings];
  assert.equal(s.dailyCap, 5);
  assert.equal(s.basis, 'beforeFees');
  assert.equal(s.priceNote, STORED.priceNote);
  assert.deepEqual(s.salesperson, STORED.salesperson);
  assert.deepEqual(s.defaults, STORED.defaults);
  assert.deepEqual(s.rewrite, STORED.rewrite, 'the rewrite key typed on this computer stays');
  assert.deepEqual(s.legal, STORED.legal);
  assert.equal(s.autoRescan, true);
  assert.equal(s.notify, false);
  assert.equal(s.readySort, 'price');
  assert.equal(s.newDays, 14);
  assert.deepEqual(s.myStores, MY_STORE.myStores);
  assert.equal(local[SITES_KEY][ORIGIN].auto, true);
  assert.equal(sync[PROFILE_KEY].salesperson.closingLine, STORED.salesperson.closingLine);
  assert.equal(sync[PROFILE_KEY].rewrite.key, undefined, 'the key never goes to the synced profile');
});

test('on a second computer set-up starts from the synced profile and Finish set-up keeps the person\'s fields in it', async () => {
  const { local, sync } = browser({ sync: { [PROFILE_KEY]: profile(ORIGIN) } });
  await start();
  await nextUntil('you');
  assert.equal(document.getElementById('wizName').value, 'Sam', 'the You step pre-fills the name from the profile');
  assert.equal(document.getElementById('wizTitle').value, 'sales manager');
  await nextUntil('terms');
  await handleWizardClick('wizFinish', ctx);
  assert.equal(wiz.step, 'done', wiz.error);

  const p = sync[PROFILE_KEY];
  assert.deepEqual(p.salesperson, profile(ORIGIN).salesperson, 'name, role and closing line are kept');
  assert.deepEqual(p.defaults, { titleStatus: '', condition: 'Good' }, 'the listing defaults are kept');
  assert.deepEqual(p.rewrite, { enabled: true, endpoint: 'https://rewrite.example-backend.test' });
  assert.deepEqual(p.legal, profile(ORIGIN).legal);
  assert.equal(p.dailyCap, 5, 'saved on this website, the dealership part comes too');
  assert.equal(p.priceNote, 'Tax and tags extra.');
  assert.equal(local[k.settings].salesperson.closingLine, profile(ORIGIN).salesperson.closingLine);
});

test('a profile saved on another dealer\'s website brings only the person\'s fields to set-up', async () => {
  const { local, sync } = browser({ sync: { [PROFILE_KEY]: profile('https://other-dealer.test') } });
  await start();
  await nextUntil('terms');
  await handleWizardClick('wizFinish', ctx);
  assert.equal(wiz.step, 'done', wiz.error);

  const s = local[k.settings];
  assert.deepEqual(s.salesperson, profile(ORIGIN).salesperson, 'the person\'s name, role and closing line follow them');
  assert.deepEqual(s.defaults, { titleStatus: '', condition: 'Good' });
  assert.equal(s.rewrite.endpoint, 'https://rewrite.example-backend.test');
  assert.equal(s.dailyCap, 10, 'the other dealer\'s cap is not this one\'s');
  assert.equal(s.priceNote, '', 'nor its price note');
  assert.equal(sync[PROFILE_KEY].origin, ORIGIN, 'the profile is saved again from this website');
  assert.equal(sync[PROFILE_KEY].salesperson.closingLine, profile(ORIGIN).salesperson.closingLine);
});

test('on a website with no settings and no profile, set-up still starts from the defaults the first read works out', async () => {
  const { local } = browser();
  await start();
  await handleWizardClick('wizNext', ctx);
  assert.equal(wiz.step, 'scan');
  const s = local[k.settings];
  assert.equal(s.dailyCap, 10);
  assert.equal(s.basis, 'website');
  assert.equal(s.autoRescan, false);
  assert.equal(s.salesperson.name, '');
  assert.equal(wiz.scan.keptCars, null, 'an ordinary read is not held back, so it keeps no earlier scan\'s cars');
  assert.match(unesc(html), /<div class="banner good">6 used cars read from Example Motors\. 3 stores found\.<\/div>/, 'the scan step shows the read\'s cars and stores in the good line');
  await handleWizardClick('wizQuit', ctx);
});

// Set-up's Price step is the same choice as Settings' "Price to post", and a
// change there is for new posts too: a listing already posted keeps the price
// it was posted at (stamped with the basis in force until now before the new
// one is saved), so the final read lists no price edit the website did not
// make. The posting rules allow one only when the website changes.
test('a price to post changed at set-up\'s Price step is for new posts: a posted listing keeps its price and gets no price item', async () => {
  const ram = vehicle('usedNormal');
  const posted = { [ram.vin]: { name: ram.name, price: ram.priceBeforeFees, postedAt: '2026-09-28T15:00:00.000Z' } }; // posted at the lower price, before entries carried a basis
  const { local } = browser({
    local: { [k.settings]: structuredClone(STORED), [k.posted]: posted, [SITES_KEY]: { [ORIGIN]: { name: 'Example Motors', auto: true } } },
    granted: [ORIGIN],
  });
  await start();
  await nextUntil('price');
  assert.match(html, /id="wizBasisNote">You have one posted listing on this website\. A change here is for new posts: that listing keeps the price it was posted at, and rescans keep checking it against the website on that price\.</);
  handleWizardChange({ name: 'wizBasis', value: 'website' }); // the website's main price
  ctx.render();
  assert.equal(wiz.settings.basis, 'website');
  await nextUntil('terms');
  await handleWizardClick('wizFinish', ctx);
  assert.equal(wiz.step, 'done', wiz.error);

  assert.equal(local[k.settings].basis, 'website', 'new posts take the main price');
  assert.deepEqual([local[k.posted][ram.vin].price, local[k.posted][ram.vin].basis], [ram.priceBeforeFees, 'beforeFees'], 'the listing keeps its price, recorded as posted at the lower price');
  assert.deepEqual((local[k.diff].priceUpdates || []).filter((p) => p.vin === ram.vin), [], 'no raise the website did not make');
});

// ---------- a full storage ----------
// Chrome's storage for the extension has a fixed quota. A write set-up makes
// that hits it says so in the words the popup and the panel use
// (STORAGE_FULL: what to clear), never that the tab is gone, and the step it
// happened on never hangs on "Reading the used inventory…" or "Finishing…".

// Writes of the keys in `full` fail the way Chrome fails them at the quota.
function fillUp(full) {
  const set = globalThis.chrome.storage.local.set;
  globalThis.chrome.storage.local.set = async (obj) => {
    if (Object.keys(obj).some((key) => full.has(key))) throw new Error('Resource::kQuotaBytes quota exceeded');
    return set(obj);
  };
}

test('a full storage during the first read says what to clear, never that the tab is gone, and Read the website works again once there is room', async () => {
  const { local } = browser();
  const full = new Set([SITES_KEY]); // the website's entry in the rescan registry, written by the read itself
  fillUp(full);
  await start();
  await handleWizardClick('wizNext', ctx);
  assert.equal(wiz.step, 'scan');
  assert.equal(wiz.error, STORAGE_FULL);
  assert.ok(!wiz.error.includes(TAB_GONE));
  assert.equal(wiz.busy, false);
  assert.match(html, /Clear the numbers on the Numbers tab/);
  assert.match(html, /id="wizScan" >/, 'Read the website can be clicked again');

  // the snapshot write fails instead: the click still ends, and the step is not left reading
  full.clear();
  full.add(k.snapshot);
  await handleWizardClick('wizScan', ctx); // resolves: no rejection left for the panel to swallow
  assert.equal(wiz.error, STORAGE_FULL);
  assert.equal(wiz.busy, false);
  assert.equal(wiz.scan, null, 'a read that could not be kept is not shown as done');
  assert.doesNotMatch(html, /Reading the used inventory/);
  assert.match(html, /id="wizScan" >/);
  assert.equal(local[k.snapshot], undefined);

  full.clear();
  await handleWizardClick('wizScan', ctx);
  assert.equal(wiz.error, '');
  assert.ok(wiz.scan && wiz.scan.cars > 0, 'read once there is room');
  assert.ok(local[k.snapshot], 'and kept');
});

test('a full storage at Finish set-up says what to clear and leaves Finish set-up to click again, never "Finishing…"', async () => {
  const { local } = browser();
  await start();
  await nextUntil('terms');
  const full = new Set([k.settings]);
  fillUp(full);
  await handleWizardClick('wizFinish', ctx); // resolves
  assert.equal(wiz.step, 'terms');
  assert.equal(wiz.busy, false);
  assert.equal(wiz.error, STORAGE_FULL);
  assert.match(html, /Clear the numbers on the Numbers tab/);
  assert.doesNotMatch(html, /Finishing…/);
  assert.equal(local[k.wizardDone], undefined, 'set-up is not recorded as done');

  // the last write, the one that records set-up as done, fails
  full.clear();
  full.add(k.wizardDone);
  await handleWizardClick('wizFinish', ctx);
  assert.equal(wiz.busy, false);
  assert.equal(wiz.error, STORAGE_FULL);
  assert.doesNotMatch(html, /Finishing…/);

  full.clear();
  await handleWizardClick('wizFinish', ctx);
  assert.equal(wiz.step, 'done', wiz.error);
  assert.equal(wiz.error, '');
  assert.ok(local[k.wizardDone]);
});

test('a full storage when set-up saves its progress is shown on the step, and the click still ends', async () => {
  browser();
  await start();
  await nextUntil('store');
  fillUp(new Set([k.wizard])); // the wizard's own progress
  await handleWizardClick('wizNext', ctx); // resolves
  assert.equal(wiz.step, 'you', 'the step moves on; only resuming after closing the panel is lost');
  assert.equal(wiz.error, STORAGE_FULL);
  assert.match(html, /Clear the numbers on the Numbers tab/, 'the You step shows it');
});


test('a storage error shown on the Permission step goes once Allow automatic rescans is granted', async () => {
  browser();
  await start();
  await nextUntil('permission');
  wiz.error = STORAGE_FULL; // an earlier save on this step could not be kept
  ctx.render();
  assert.match(html, /Clear the numbers on the Numbers tab/);
  globalThis.chrome.permissions.request = async () => true; // the person clicks Allow in Chrome's prompt
  await handleWizardClick('wizGrant', ctx);
  assert.equal(wiz.granted, true);
  assert.equal(wiz.error, '', 'the grant and the save after it both went through');
  assert.doesNotMatch(html, /Clear the numbers on the Numbers tab/);
  assert.match(html, /Permission granted\. Automatic rescans are on\./);
});

// The text the You step's warning under a field shows, with its tags and entities gone.
const warningText = (id) => unesc(((new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)</div>`).exec(html)) || [])[1] || '').replace(/<[^>]+>/g, '').trim();
const storeBox = (name) => inputs().find((i) => i.className === 'wizStore' && i.value === name);

test('set-up\'s store step ticks the box of a saved store name with a space at either end, as its hint says, and Next keeps the name as the website lists it', async () => {
  browser({ local: { [k.settings]: { ...structuredClone(STORED), myStores: [`${WAYNESBURG} `] }, [k.snapshot]: snapshot([['usedNormal', {}]]) } });
  await start();
  await nextUntil('store');
  assert.match(html, /your earlier choice is ticked/, 'the hint says the saved choice is ticked');
  assert.equal(storeBox(WAYNESBURG).checked, true, 'and the box for that store is ticked');
  await nextUntil('you');
  assert.deepEqual(wiz.settings.myStores, [WAYNESBURG], 'Next keeps the store by the name the website lists');
});

test('set-up\'s first read keeps a saved store name with a space at either end as the website lists it, so the store stays ticked', async () => {
  browser({ local: { [k.settings]: { ...structuredClone(STORED), myStores: [`${WAYNESBURG} `] } } });
  await start();
  await nextUntil('store');
  assert.deepEqual(wiz.settings.myStores, [WAYNESBURG], 'the first read keeps the ticked store, by its listed name');
  assert.match(html, /your earlier choice is ticked/);
  assert.equal(storeBox(WAYNESBURG).checked, true);
});

test('set-up\'s You step keeps the role\'s warning while a car on the read names no store, though the ticked store holds the number, and drops it once every car is named', async () => {
  const dealer = { name: 'Example Motors', city: 'Springfield', state: 'OH', zip: '43210' };
  const settings = { ...structuredClone(STORED), myStores: ['Route 2 Motors'], salesperson: { name: 'Sam', title: 'Team 2' }, dealer };
  const records = (blankFirst) => RECORDS.map((r, i) => {
    const store = blankFirst && i === 0 ? '' : 'Route 2 Motors';
    return { ...structuredClone(r), extra_fields: { ...r.extra_fields, meta_location: store, location_rt: store } };
  });
  const plain = settingNumberWarning('role', 'Team 2', dealer);
  assert.notEqual(plain, '', 'the role\'s number is one the dealership does not hold');
  browser({ local: { [k.settings]: settings }, records: records(true) });
  await start();
  await nextUntil('you');
  assert.equal(warningText('wizTitleWarn'), plain, 'the car with no store name still fails the number check');
  browser({ local: { [k.settings]: settings }, records: records(false) });
  await start();
  await nextUntil('you');
  assert.equal(warningText('wizTitleWarn'), '', 'every car is named, so the ticked store holds the number');
});

test('set-up\'s You step counts the stores over the lot Settings reads: a read held back keeps the last scan\'s lot, so a car on that lot with no store name keeps the role\'s warning', async () => {
  const dealer = { name: 'Example Motors', city: 'Springfield', state: 'OH', zip: '43210' };
  const settings = { ...structuredClone(STORED), myStores: ['Route 2 Motors'], salesperson: { name: 'Sam', title: 'Team 2' }, dealer };
  const plain = settingNumberWarning('role', 'Team 2', dealer);
  assert.notEqual(plain, '', 'the role\'s number is one the dealership does not hold');
  // twelve cars on the last scan, all at the ticked store but the first, which names no store
  const lot = Array.from({ length: 12 }, (_, i) => ['usedNormal', { vin: `LOT${i}`, extra_fields: { meta_location: i ? 'Route 2 Motors' : '', location_rt: i ? 'Route 2 Motors' : '' } }]);
  // this read finds one car, at the ticked store: most of the lot is missing, so the read is held back and the last scan's lot stands
  const one = RECORDS.slice(0, 1).map((r) => ({ ...structuredClone(r), extra_fields: { ...r.extra_fields, meta_location: 'Route 2 Motors', location_rt: 'Route 2 Motors' } }));
  browser({ local: { [k.settings]: settings, [k.snapshot]: snapshot(lot, settings) }, records: one });
  await start();
  await nextUntil('you');
  assert.equal(warningText('wizTitleWarn'), plain, 'the car with no store name on the last scan keeps the warning, as Settings keeps it');
});

test('set-up\'s first read drops a saved store the website no longer lists, so no car is held back as at another store', async () => {
  browser({ local: { [k.settings]: { ...structuredClone(STORED), myStores: ['Gone Motors'] } } });
  await start();
  await nextUntil('store');
  assert.equal(wiz.settings.myStores.includes('Gone Motors'), false, 'the store the website does not list is not kept');
  assert.ok(wiz.scan.ready > 0, 'the cars the website lists as ready are still ready, with no store filter');
});

test('set-up\'s store step draws the boxes of the lot Settings reads: a read held back keeps the last scan\'s stores, so the store ticked there stays ticked through Next', async () => {
  const settings = { ...structuredClone(STORED), myStores: ['Route 2 Motors'] };
  // twelve cars on the last scan, all at the ticked store
  const lot = Array.from({ length: 12 }, (_, i) => ['usedNormal', { vin: `LOT${i}`, extra_fields: { meta_location: 'Route 2 Motors', location_rt: 'Route 2 Motors' } }]);
  // this read finds one car, at another store: most of the lot is missing, so the read is held back
  const one = RECORDS.slice(0, 1).map((r) => ({ ...structuredClone(r), extra_fields: { ...r.extra_fields, meta_location: 'Other Store', location_rt: 'Other Store' } }));
  browser({ local: { [k.settings]: settings, [k.snapshot]: snapshot(lot, settings) }, records: one });
  await start();
  await nextUntil('store');
  assert.equal(storeBox('Route 2 Motors')?.checked, true, 'the box of the store the lot is at is drawn, and ticked');
  assert.equal(storeBox('Other Store'), undefined, 'the store only this read names has no box');
  await nextUntil('you');
  assert.deepEqual(wiz.settings.myStores, ['Route 2 Motors'], 'Next keeps the store');
});

test('a held-back read\'s scan line gives this read\'s count and the kept lot\'s count and stores', async () => {
  const settings = { ...structuredClone(STORED), myStores: ['Route 2 Motors'] };
  const lot = Array.from({ length: 12 }, (_, i) => ['usedNormal', { vin: `LOT${i}`, extra_fields: { meta_location: 'Route 2 Motors', location_rt: 'Route 2 Motors' } }]);
  const one = RECORDS.slice(0, 1).map((r) => ({ ...structuredClone(r), extra_fields: { ...r.extra_fields, meta_location: 'Other Store', location_rt: 'Other Store' } }));
  browser({ local: { [k.settings]: settings, [k.snapshot]: snapshot(lot, settings) }, records: one });
  await start();
  await nextUntil('scan');
  await handleWizardClick('wizScan', ctx); // Read the website again (Next ran the first read): wiz.step stays on the scan step
  assert.equal(wiz.step, 'scan');
  assert.match(unesc(html), /1 used car read from Example Motors this time, but held back, so the last scan's 12 used cars are kept\. 1 store found among them\./);
});
