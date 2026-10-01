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
import { fixtures, fakeDealerPage, fakeChrome, vehicle, MY_STORE } from './helpers.js';
import { wiz, wizardHtml, startWizard, handleWizardClick } from '../extension/wizard.js';
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
function browser({ local = {}, sync = {}, granted = [] } = {}) {
  const page = fakeDealerPage({ records: RECORDS, origin: ORIGIN, name: 'Example Motors' });
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
  await handleWizardClick('wizQuit', ctx);
});
