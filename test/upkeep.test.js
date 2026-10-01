// Listing upkeep fills a new price into a listing's Price box and ticks a
// take-down off when the listing shows it sold, so it must act only on this
// car's own listing. These run fillForm.js's own readListingInPage on small
// stand-in pages, and upkeep.js's onListing on what it reads:
//   - with the listing's id known, only its id in the address counts: another
//     listing of the same year, make and model never does;
//   - with no saved link, never Marketplace's Your listings page (every
//     listing's name is on it), and elsewhere every word of the car's name as
//     a whole word plus the price it was listed at (or the new price).
// Facebook's real pages are not verified (listingSigns.js says so); these
// pages only stand in for the shapes the reader looks at.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readListingInPage } from '../extension/facebook/fillForm.js';
import { LISTING_SIGNS } from '../extension/facebook/listingSigns.js';
import { FORM_MAP } from '../extension/facebook/formMap.js';
import { onListing, listingIdFrom, startUpkeep, endUpkeep, up } from '../extension/upkeep.js';

// A page as the reader walks it: text nodes, each inside a plain block or a
// dialog, and an optional Price box (in a dialog or on the page).
function node(tag, attrs = {}, parent = null) {
  return {
    tagName: tag.toUpperCase(), attrs, parentElement: parent, isConnected: true, id: '', value: attrs.value || '',
    getAttribute(n) { return this.attrs[n] ?? null; },
    checkVisibility() { return true; },
    getBoundingClientRect() { return { width: 100, height: 20 }; },
    closest(sel) {
      for (let n = this; n; n = n.parentElement) {
        if (sel === 'label' ? n.tagName === 'LABEL' : (n.attrs.role === 'dialog' || ['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT'].includes(n.tagName) || n.attrs.role === 'button')) return n;
      }
      return null;
    },
  };
}
function readPage({ url, title = 'Marketplace', texts = [], dialog = [], priceBox = null }, expect) {
  const body = node('body');
  const block = node('div', {}, body);
  const box = node('div', { role: 'dialog' }, body);
  const nodes = [...texts.map((t) => [t, block]), ...dialog.map((t) => [t, box])];
  const inputs = [];
  if (priceBox) {
    const label = node('label', {}, priceBox.inDialog ? box : block);
    inputs.push(node('input', { 'aria-label': 'Price', value: priceBox.value }, label));
  }
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

const LIMITED = '2019 Jeep Grand Cherokee Limited';
const LAREDO = '2019 Jeep Grand Cherokee Laredo';
const YOURS = FORM_MAP.yourListingsUrl;
const at = (id, edit = false) => (edit ? `https://www.facebook.com/marketplace/edit/?listing_id=${id}` : `https://www.facebook.com/marketplace/item/${id}/`);
const decide = (seen, id = '') => onListing(seen, { id, yourListingsUrl: YOURS });

test('upkeep never takes another listing of the same year, make and model for this car\'s', () => {
  const noLink = { id: '', name: LIMITED, prices: [31995, 30995] };
  // Your listings, with the Laredo's edit form open over it: this car's card is on the page, but nothing is filled there
  const list = readPage({ url: YOURS, texts: ['Your listings', LIMITED, '$31,995', 'Active', LAREDO, '$27,500', 'Active'], dialog: ['Edit listing', LAREDO], priceBox: { value: '27500', inDialog: true } }, noLink);
  assert.equal(list.matchesName, true, 'the name is on the list page');
  assert.equal(decide(list), false, 'never on Your listings');
  // the Laredo marked sold on that page: not this car's take-down
  const soldThere = readPage({ url: YOURS, texts: ['Your listings', LIMITED, '$31,995', 'Active', LAREDO, '$27,500', 'Sold'] }, noLink);
  assert.equal(soldThere.sold, true);
  assert.equal(decide(soldThere), false);

  // the Laredo's own edit form: with the Limited's id known, only that id counts; with none, its name is not all there
  const laredoEdit = readPage({ url: at(222, true), title: 'Edit listing', texts: [`Edit listing: ${LAREDO}`, '$31,995'], priceBox: { value: '31995' } }, { id: '111', name: LIMITED, prices: [31995, 30995] });
  assert.deepEqual([laredoEdit.matchesId, decide(laredoEdit, '111')], [false, false], 'the other listing\'s address never matches a known id');
  const laredoNoLink = readPage({ url: at(222, true), texts: [`Edit listing: ${LAREDO}`], priceBox: { value: '31995' } }, noLink);
  assert.deepEqual([laredoNoLink.matchesName, laredoNoLink.matchesPrice, decide(laredoNoLink)], [false, true, false], 'Limited is not on the Laredo\'s page');

  // the same name at another price: a second listing of the same model is not this one
  const twin = readPage({ url: at(333), texts: [LIMITED, '$29,500'] }, noLink);
  assert.deepEqual([twin.matchesName, twin.matchesPrice, decide(twin)], [true, false, false]);

  // whole words only: "1500" is not "15000", "LT" is not "LTZ"
  const silverado = { id: '', name: '2019 Chevrolet Silverado 1500 LT', prices: [28000] };
  assert.equal(readPage({ url: at(444), texts: ['2019 Chevrolet Silverado 15000 LTZ', '$28,000'] }, silverado).matchesName, false);
  assert.equal(readPage({ url: at(444), texts: ['2019 Chevrolet Silverado 1500 LT', '$28,000'] }, silverado).matchesName, true);
});

test('upkeep finds this car\'s own listing by its id, or with no link by its whole name and listed price, and then by the id it shows', () => {
  // the saved link's id in the address: the item page and its edit form
  const known = { id: '111', name: LIMITED, prices: [31995, 30995] };
  assert.equal(decide(readPage({ url: at(111), texts: [LIMITED, '$31,995'] }, known), '111'), true);
  assert.equal(decide(readPage({ url: at(111, true), texts: ['Edit listing'], priceBox: { value: '31995' } }, known), '111'), true);

  // no link: its own page, by the full name and the price it was listed at
  const noLink = { id: '', name: LIMITED, prices: [31995, 30995] };
  const own = readPage({ url: at(111), title: `${LIMITED} | Facebook Marketplace`, texts: [LIMITED, '$31,995', 'Listed 3 days ago'] }, noLink);
  assert.equal(decide(own), true);
  assert.equal(listingIdFrom(own.url, FORM_MAP.listingUrlPattern), '111', 'its id is what counts from then on');
  // the new price shown after the update also identifies it
  assert.equal(decide(readPage({ url: at(111), texts: [LIMITED, '$30,995'] }, noLink)), true);
  // the price in the edit form's box counts as on the page
  assert.equal(decide(readPage({ url: at(111, true), texts: [`Edit listing: ${LIMITED}`], priceBox: { value: '31,995' } }, noLink)), true);

  // no link and no listed price: nothing on any page is taken as this car's
  const nothing = { id: '', name: LIMITED, prices: [] };
  assert.equal(decide(readPage({ url: at(111), texts: [LIMITED, '$31,995'] }, nothing)), false);
  assert.equal(onListing(null), false);
});

// A saved link that is not a listing's own address (the Your listings page,
// kept by an older version or another computer) counts as no link: the tab
// opens on Your listings with the note that tells the person to open the
// listing there, and no id is taken from it. A listing's own link opens the
// listing, with no note. Run with upkeep.js's own startUpkeep; Chrome's tabs
// are a stand-in.
test('upkeep treats a saved link that is not a listing\'s own address as no link, and says to open the listing', async () => {
  const opened = [];
  globalThis.chrome = { tabs: { create: async ({ url }) => { opened.push(url); return { id: 9 }; } } };
  const ctx = { render: () => {}, map: () => FORM_MAP };
  const begin = async (listingUrl) => {
    const started = startUpkeep({ origin: 'https://www.example-motors.test', vin: 'aaa', kind: 'price', price: 19000, listingUrl, name: 'Car A', listedPrice: 20000 }, ctx);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    const seen = { url: opened[opened.length - 1], listingUrl: up.listingUrl, note: up.note };
    endUpkeep();
    await started;
    return seen;
  };
  try {
    const yours = await begin(FORM_MAP.yourListingsUrl);
    assert.equal(yours.url, FORM_MAP.yourListingsUrl);
    assert.equal(yours.listingUrl, '', 'no link');
    assert.match(yours.note, /No link to this car's own listing was saved.*open the listing for Car A there/);
    const item = await begin('https://m.facebook.com/marketplace/item/111/');
    assert.deepEqual(item, { url: 'https://www.facebook.com/marketplace/item/111/', listingUrl: 'https://www.facebook.com/marketplace/item/111/', note: '' });
  } finally {
    endUpkeep();
    delete globalThis.chrome;
  }
});
