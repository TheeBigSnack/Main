import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl, onCreatePage, isNewListingFromForm, showsPostedCar, watchForListing, listingLink } from '../extension/facebook/detectPost.js';
import { FORM_MAP } from '../extension/facebook/formMap.js';
import { LISTING_SIGNS } from '../extension/facebook/listingSigns.js';
import { readListingInPage } from '../extension/facebook/fillForm.js';

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


// A notification or a link clicked on the form page also takes the tab
// straight from the form to a listing, of another car. A queue records the
// post by itself only when the listing page shows the car just published
// (what readListingInPage saw, asked for the listing's id and this car's
// name, VIN and filled price), and never when the create form is still on
// the page.
test('a queue takes a listing page as the post only when it shows the car just published', () => {
  const page = { matchesId: true, sold: false, unavailable: false, matchesVin: false, vinInText: false, formOnPage: false, hasPriceBox: false, matchesName: false, matchesPrice: false };
  // this car's VIN in the page's text: yes, whatever else
  const vin = { ...page, matchesVin: true, vinInText: true };
  assert.equal(showsPostedCar(vin, { namesakes: 2 }), true);
  assert.equal(showsPostedCar(vin), true, 'namesakes unknown');
  // its name and price, with no other posted car of that name: yes; with one, or unknown: the VIN is needed
  const namePrice = { ...page, matchesName: true, matchesPrice: true };
  assert.equal(showsPostedCar(namePrice, { namesakes: 0 }), true);
  assert.equal(showsPostedCar(namePrice, { namesakes: 1 }), false, 'another posted car has this name');
  assert.equal(showsPostedCar(namePrice, { namesakes: null }), false);
  assert.equal(showsPostedCar(namePrice), false);
  // the name alone or the price alone: another listing
  assert.equal(showsPostedCar({ ...page, matchesName: true }, { namesakes: 0 }), false);
  assert.equal(showsPostedCar({ ...page, matchesPrice: true }, { namesakes: 0 }), false);
  // another car's listing opened from a notification
  assert.equal(showsPostedCar(page, { namesakes: 0 }), false);
  // not that listing's address any more (the tab moved on), sold, gone, or nothing read
  assert.equal(showsPostedCar({ ...vin, matchesId: false }, { namesakes: 0 }), false);
  assert.equal(showsPostedCar({ ...vin, sold: true }, { namesakes: 0 }), false);
  assert.equal(showsPostedCar({ ...vin, unavailable: true }, { namesakes: 0 }), false);
  for (const nothing of [null, undefined]) assert.equal(showsPostedCar(nothing, { namesakes: 0 }), false);
  // the create form still on the page (its boxes, its Price box), or a reader that does not say: never, whatever it carries
  for (const form of [{ formOnPage: true }, { hasPriceBox: true }, { formOnPage: undefined }]) {
    assert.equal(showsPostedCar({ ...vin, matchesName: true, matchesPrice: true, ...form }, { namesakes: 0 }), false, JSON.stringify(form));
  }
  // the VIN only in a box (the form's description), not in the page's text: not by the VIN
  assert.equal(showsPostedCar({ ...page, matchesVin: true }, { namesakes: 2 }), false);
});

// fillForm.js's own readListingInPage on small stand-in pages (Facebook's
// real pages are not verified; these only stand in for the shapes the
// reader looks at): text nodes in a plain block or a dialog, and boxes with
// their labels.
function readPage({ url, title = 'Marketplace', texts = [], dialog = [], boxes = [] }, expect) {
  const el = (tag, attrs = {}, parent = null) => ({
    tagName: tag.toUpperCase(), attrs, parentElement: parent, isConnected: true, id: '', value: attrs.value || '',
    getAttribute(n) { return this.attrs[n] ?? null; },
    checkVisibility() { return true; },
    getBoundingClientRect() { return { width: 100, height: 20 }; },
    closest(sel) {
      for (let n = this; n; n = n.parentElement) {
        if (sel === 'label' ? n.tagName === 'LABEL' : (n.attrs.role === 'dialog' || ['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT'].includes(n.tagName))) return n;
      }
      return null;
    },
  });
  const body = el('body');
  const block = el('div', {}, body);
  const over = el('div', { role: 'dialog' }, body);
  const nodes = [...texts.map((t) => [t, block]), ...dialog.map((t) => [t, over])];
  const inputs = boxes.map((b) => el(b.tag || 'input', { 'aria-label': b.label, value: b.value }, block));
  const saved = { location: globalThis.location, document: globalThis.document, NodeFilter: globalThis.NodeFilter };
  globalThis.location = { href: url };
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.document = {
    title, body,
    getElementById: () => null,
    createTreeWalker: () => { let i = -1; return { nextNode: () => { i += 1; return i < nodes.length ? { nodeValue: nodes[i][0], parentElement: nodes[i][1] } : null; } }; },
    querySelectorAll: () => inputs,
  };
  try {
    return readListingInPage(FORM_MAP, LISTING_SIGNS, expect);
  } finally {
    Object.assign(globalThis, saved);
  }
}

// The address already names another listing (616161) while the create form
// is still drawn: a client-side page change that has not redrawn yet, or a
// listing opened as a dialog over the form. The form's boxes and its preview
// carry this car's VIN, name and price; the dialog shows the other car, and
// its text is skipped. Never taken for this car's new listing. The listing
// itself, a published page with its description as text, is.
test('the create form still drawn under another listing\'s address is never taken for the car\'s new listing', () => {
  const VIN = '1C4SJVDT7NS142834';
  const NAME = '2022 Jeep Wagoneer Series III';
  const expect = { id: '616161', name: NAME, prices: [38383], vin: VIN };
  const url = 'https://www.facebook.com/marketplace/item/616161/';
  const overForm = readPage({
    url,
    texts: ['Vehicle for sale', 'Preview', NAME, '$38,383', `Offered by the dealership. VIN ${VIN}`],
    boxes: [{ label: 'Price', value: '$38,383' }, { label: 'Description', tag: 'textarea', value: `Offered by the dealership. VIN ${VIN}` }, { label: 'VIN', value: VIN }],
    dialog: ['2022 Jeep Wagoneer Series II', '$41,500', 'Listed by someone else'],
  }, expect);
  assert.deepEqual([overForm.matchesId, overForm.matchesVin, overForm.matchesName, overForm.matchesPrice], [true, true, true, true], 'the form carries this car everywhere');
  assert.deepEqual([overForm.formOnPage, overForm.hasPriceBox], [true, true]);
  assert.equal(showsPostedCar(overForm, { namesakes: 0 }), false, 'the form is not the listing');
  // the form with its Price box hidden or gone but its Description box still there: the form all the same
  const halfDrawn = readPage({ url, texts: [NAME, '$38,383'], boxes: [{ label: 'Description', tag: 'textarea', value: `VIN ${VIN}` }] }, expect);
  assert.deepEqual([halfDrawn.formOnPage, halfDrawn.hasPriceBox, halfDrawn.vinInText, showsPostedCar(halfDrawn, { namesakes: 0 })], [true, false, false, false]);

  // the new listing, published: its description as text, a box to message the seller at most
  const listing = readPage({
    url: 'https://www.facebook.com/marketplace/item/515151/',
    title: `${NAME} | Marketplace`,
    texts: [NAME, '$38,383', 'Listed a minute ago', `Offered by the dealership. VIN ${VIN}`],
    boxes: [{ label: 'Send seller a message', tag: 'textarea', value: 'Hi, is this available?' }],
  }, { ...expect, id: '515151' });
  assert.deepEqual([listing.formOnPage, listing.vinInText], [false, true]);
  assert.equal(showsPostedCar(listing, { namesakes: 3 }), true);
  // another car's listing, published: not this car
  const other = readPage({ url, texts: ['2022 Jeep Wagoneer Series II', '$41,500', 'VIN 1C4SJVBT0NS000616'] }, expect);
  assert.deepEqual([other.formOnPage, other.vinInText, showsPostedCar(other, { namesakes: 0 })], [false, false, false]);
  // this car's VIN typed into a message box on another listing's page: a box, not the page's text
  const typed = readPage({ url, texts: ['2022 Jeep Wagoneer Series II', '$41,500'], boxes: [{ label: 'Send seller a message', tag: 'textarea', value: `Is this like ${VIN}?` }] }, expect);
  assert.deepEqual([typed.matchesVin, typed.vinInText, showsPostedCar(typed, { namesakes: 0 })], [true, false, false]);
});
