import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl, onCreatePage, isNewListingFromForm, watchForListing } from '../extension/facebook/detectPost.js';
import { FORM_MAP } from '../extension/facebook/formMap.js';

test('a listing address means it posted; the "your listings" page probably does; anything else is nothing', () => {
  assert.deepEqual(classifyUrl('https://www.facebook.com/marketplace/item/1234567890/', FORM_MAP), { status: 'listing', url: 'https://www.facebook.com/marketplace/item/1234567890/', id: '1234567890' });
  assert.equal(classifyUrl('https://www.facebook.com/marketplace/item/123?ref=share', FORM_MAP).status, 'listing');
  assert.equal(classifyUrl('https://www.facebook.com/marketplace/you/selling', FORM_MAP).status, 'probably');
  assert.equal(classifyUrl('https://www.facebook.com/marketplace/selling/', FORM_MAP).status, 'probably');
  assert.equal(classifyUrl(FORM_MAP.createUrl, FORM_MAP), null);
  assert.equal(classifyUrl('https://www.facebook.com/marketplace/', FORM_MAP), null);
  assert.equal(classifyUrl('', FORM_MAP), null);
  assert.equal(classifyUrl(undefined, FORM_MAP), null);
});

test('the form map only ever points at the create page and reads addresses; it has no verified claim', () => {
  assert.equal(FORM_MAP.createUrl, 'https://www.facebook.com/marketplace/create/vehicle');
  assert.notEqual(FORM_MAP.verifiedAgainstFacebook, true, 'never claim the live form is fully verified');
  assert.ok(FORM_MAP.fields.every((f) => Array.isArray(f.name) && f.name.length && f.key && f.label && f.kind));
  assert.deepEqual(FORM_MAP.neverFill, []);
  // condition and title are choice fields with Facebook's own wordings
  const byKey = Object.fromEntries(FORM_MAP.fields.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(byKey.condition.options), ['Excellent', 'Very good', 'Good', 'Fair', 'Poor']);
  assert.deepEqual(Object.keys(byKey.titleStatus.options), ['Clean', 'Rebuilt', 'Salvage', 'Lien', 'Missing']);
  assert.equal(byKey.titleStatus.optional, true);
  assert.equal(byKey.cleanTitle.kind, 'checkbox');
});

// A stand-in for chrome.tabs: one tab whose address the test moves, as
// Chrome reports it (onUpdated with the new url).
function fakeTabs(firstUrl) {
  const listeners = { updated: new Set(), removed: new Set() };
  const tab = { id: 7, url: firstUrl };
  globalThis.chrome = {
    tabs: {
      get: async (id) => (id === tab.id ? { ...tab } : Promise.reject(new Error('no tab'))),
      onUpdated: { addListener: (fn) => listeners.updated.add(fn), removeListener: (fn) => listeners.updated.delete(fn) },
      onRemoved: { addListener: (fn) => listeners.removed.add(fn), removeListener: (fn) => listeners.removed.delete(fn) },
    },
  };
  return {
    go: (url) => {
      tab.url = url;
      for (const fn of [...listeners.updated]) fn(tab.id, { url, status: 'loading' });
    },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a listing address counts as coming from the form only when the tab moved to it straight from the create page', async () => {
  const ITEM = 'https://www.facebook.com/marketplace/item/1234567890/';
  const watch = () => watchForListing({ tabId: 7, listingUrlPattern: FORM_MAP.listingUrlPattern, afterPublishPatterns: [], createUrl: FORM_MAP.createUrl, timeoutMs: 1000 });
  try {
    // the person clicks Publish on the filled form
    let tabs = fakeTabs(FORM_MAP.createUrl);
    let w = watch();
    await settle();
    tabs.go(FORM_MAP.createUrl + '?step=2');
    tabs.go(ITEM);
    let r = await w.promise;
    assert.deepEqual([r.status, r.id, r.afterCreate], ['listing', '1234567890', true]);

    // the person leaves the form for Marketplace and opens someone else's listing in that tab
    tabs = fakeTabs(FORM_MAP.createUrl);
    w = watch();
    await settle();
    tabs.go('https://www.facebook.com/marketplace/category/vehicles');
    tabs.go('https://www.facebook.com/marketplace/item/987654321/?ref=search');
    r = await w.promise;
    assert.deepEqual([r.status, r.afterCreate], ['listing', false]);

    // the tab already shows a listing when the watch begins (a panel brought back, a tab id Chrome reused)
    fakeTabs(ITEM);
    r = await watch().promise;
    assert.deepEqual([r.status, r.afterCreate], ['listing', false]);
  } finally {
    delete globalThis.chrome;
  }
});

test('the create page is the map\'s create address, with any query; a queue records only a new listing reached from it', () => {
  assert.equal(onCreatePage(FORM_MAP.createUrl, FORM_MAP.createUrl), true);
  assert.equal(onCreatePage(FORM_MAP.createUrl + '/?ref=marketplace', FORM_MAP.createUrl), true);
  assert.equal(onCreatePage('https://www.facebook.com/marketplace/create/vehicles', FORM_MAP.createUrl), false);
  assert.equal(onCreatePage('https://www.facebook.com/marketplace/', FORM_MAP.createUrl), false);
  assert.equal(onCreatePage('http://127.0.0.1:9/marketplace/create/vehicle', FORM_MAP.createUrl), false);
  assert.equal(onCreatePage('', FORM_MAP.createUrl), false);

  const fromForm = { status: 'listing', url: 'https://www.facebook.com/marketplace/item/555/', id: '555', afterCreate: true };
  assert.equal(isNewListingFromForm(fromForm, {}, FORM_MAP), true);
  assert.equal(isNewListingFromForm({ ...fromForm, afterCreate: false }, {}, FORM_MAP), false, 'not straight from the form');
  assert.equal(isNewListingFromForm({ ...fromForm, afterCreate: undefined }, {}, FORM_MAP), false);
  assert.equal(isNewListingFromForm({ status: 'probably', url: null, id: null, afterCreate: true }, {}, FORM_MAP), false);
  const posted = { VIN1: { listingUrl: 'https://www.facebook.com/marketplace/item/555/?ref=share' }, VIN2: {} };
  assert.equal(isNewListingFromForm(fromForm, posted, FORM_MAP), false, 'a listing already recorded on this website');
  assert.equal(isNewListingFromForm({ ...fromForm, id: '556', url: 'https://www.facebook.com/marketplace/item/556/' }, posted, FORM_MAP), true);
});

