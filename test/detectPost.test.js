import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl, onCreatePage, isNewListingFromForm, watchForListing, listingLink } from '../extension/facebook/detectPost.js';
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

// The link kept for a post: a listing's own address only, Facebook's other
// spellings of it as its www address, and nothing for any other page.
test('a listing link is kept only for a listing\'s own address, as its www address; Your listings and any other page give none', () => {
  const ITEM = 'https://www.facebook.com/marketplace/item/1234567890/';
  for (const [typed, kept] of [
    [ITEM, ITEM],
    [ITEM + '?ref=share&tracking=x', ITEM],
    ['  ' + ITEM + '  ', ITEM],
    ['https://m.facebook.com/marketplace/item/1234567890/', ITEM],
    ['http://web.facebook.com/marketplace/item/1234567890/?ref=y', ITEM],
    ['https://facebook.com/marketplace/item/1234567890/', ITEM],
    ['facebook.com/marketplace/item/1234567890/', ITEM],
    ['HTTPS://WWW.FACEBOOK.COM/marketplace/item/1234567890/', ITEM],
    ['https://www.facebook.com/marketplace/item/42', 'https://www.facebook.com/marketplace/item/42'],
  ]) assert.equal(listingLink(typed, FORM_MAP), kept, typed);
  for (const typed of [
    FORM_MAP.yourListingsUrl, 'https://www.facebook.com/marketplace/selling/', 'https://www.facebook.com/marketplace/you/selling?tab=active',
    FORM_MAP.createUrl, 'https://www.facebook.com/marketplace/', 'https://www.facebook.com/marketplace/item/abc/',
    'https://www.facebook.com.example.test/marketplace/item/1/', 'https://www.facebook.com@example.test/marketplace/item/1/', 'https://example.test/marketplace/item/1/',
    'ftp://www.facebook.com/marketplace/item/1/', 'javascript:alert(1)', 'not an address', '', null, undefined,
  ]) assert.equal(listingLink(typed, FORM_MAP), '', String(typed));
  // a map with other addresses (the mock form's) keeps its own listing addresses as given
  const mock = { ...FORM_MAP, createUrl: 'http://127.0.0.1:5555/marketplace/create/vehicle', listingUrlPattern: '^http://127\\.0\\.0\\.1:5555/marketplace/item/(\\d+)' };
  assert.equal(listingLink('http://127.0.0.1:5555/marketplace/item/424242/', mock), 'http://127.0.0.1:5555/marketplace/item/424242/');
  const byQuery = { ...FORM_MAP, createUrl: 'http://localhost:8080/demo/marketplace/create.html', listingUrlPattern: '^http://localhost:8080/demo/marketplace/item\\.html\\?id=(\\d+)' };
  assert.equal(listingLink('http://localhost:8080/demo/marketplace/item.html?id=55', byQuery), 'http://localhost:8080/demo/marketplace/item.html?id=55', 'a query the pattern needs stays');
  assert.equal(listingLink(ITEM, mock), '', 'a Facebook address is not the mock form\'s listing');
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

