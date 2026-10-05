// Listing upkeep fills a new price into a listing's Price box and ticks a
// take-down off when the listing shows it sold, so it must act only on this
// car's own listing. These run fillForm.js's own readListingInPage on small
// stand-in pages, and upkeep.js's onListing on what it reads:
//   - with the listing's id known, only its id in the address counts: another
//     listing of the same year, make and model never does;
//   - with no saved link, never Marketplace's Your listings page (every
//     listing's name is on it), and elsewhere every word of the car's name as
//     a whole word plus the price it was listed at (or the new price), and
//     its VIN too when another posted car carries the same name.
// Facebook's real pages are not verified (listingSigns.js says so); these
// pages only stand in for the shapes the reader looks at.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readListingInPage } from '../extension/facebook/fillForm.js';
import { LISTING_SIGNS } from '../extension/facebook/listingSigns.js';
import { FORM_MAP } from '../extension/facebook/formMap.js';
import { onListing, listingIdFrom, startUpkeep, endUpkeep, up, namesakesOf, offTargetNote, upkeepHtml } from '../extension/upkeep.js';

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
function readPage({ url, title = 'Marketplace', texts = [], dialog = [], priceBox = null, boxes = [] }, expect) {
  const body = node('body');
  const block = node('div', {}, body);
  const box = node('div', { role: 'dialog' }, body);
  const nodes = [...texts.map((t) => [t, block]), ...dialog.map((t) => [t, box])];
  const inputs = [];
  if (priceBox) {
    const label = node('label', {}, priceBox.inDialog ? box : block);
    inputs.push(node('input', { 'aria-label': 'Price', value: priceBox.value }, label));
  }
  for (const b of boxes) inputs.push(node(b.tag || 'textarea', { value: b.value }, block));
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

// Two units of the same car at the same price (a lot often has them) look
// alike by name and price, so with no saved link and another posted car of
// that name, the page must also show this car's VIN: its description carries
// it, and so does the edit form's VIN box. Without it nothing is filled or
// ticked off, and the panel says why.
const VIN_A = '1C4RJFBG5MC000001';
const VIN_B = '1C4RJFBG5MC000002';
test('with another posted car of the same name, upkeep needs this car\'s VIN on the page too', () => {
  const posted = {
    [VIN_A]: { name: LAREDO, price: 31995 },
    [VIN_B]: { name: LAREDO, price: 31995 },
    '1C4RJFBG5MC000003': { name: '2019 Jeep Grand Cherokee Laredo E', price: 33000 },
    '1C4RJFBG5MC000004': { name: LIMITED, price: 31995 },
    '1C4RJFBG5MC000005': { name: '2019 Jeep Grand', price: 31995 },
  };
  assert.equal(namesakesOf(posted, VIN_A, LAREDO), 2, 'the other Laredo, and the Laredo E whose name holds every word of it');
  assert.equal(namesakesOf(posted, VIN_A.toLowerCase(), LAREDO), 2, 'never itself');
  assert.equal(namesakesOf(posted, '1C4RJFBG5MC000004', LIMITED), 0);
  assert.equal(namesakesOf({}, VIN_A, LAREDO), 0);
  assert.equal(namesakesOf(null, VIN_A, LAREDO), 0);

  const mine = { id: '', name: LAREDO, prices: [31995, 30995], vin: VIN_A };
  const decideAmong = (seen, namesakes) => onListing(seen, { id: '', yourListingsUrl: YOURS, namesakes });
  // the other Laredo's page: same name, same price, its own VIN in its description
  const twin = readPage({ url: at(222), texts: [LAREDO, '$31,995', `Clean Laredo. VIN ${VIN_B}.`] }, mine);
  assert.deepEqual([twin.matchesName, twin.matchesPrice, twin.matchesVin], [true, true, false]);
  assert.equal(decideAmong(twin, 0), true, 'alone of its name, name and price are enough (as before)');
  assert.equal(decideAmong(twin, 1), false, 'with a namesake, never the other unit\'s page');
  assert.equal(decideAmong(twin, null), false, 'with the posted list unread, the same');
  // the other Laredo's edit form: the VIN box and the description hold the other VIN
  const twinEdit = readPage({ url: at(222, true), texts: [`Edit listing: ${LAREDO}`], priceBox: { value: '31995' }, boxes: [{ tag: 'input', value: VIN_B }, { value: `VIN ${VIN_B}.` }] }, mine);
  assert.equal(decideAmong(twinEdit, 1), false);
  // this car's own page and edit form: its VIN on the page, or in a box
  const own = readPage({ url: at(111), texts: [LAREDO, '$31,995', `Clean Laredo. VIN ${VIN_A}.`] }, mine);
  assert.equal(own.matchesVin, true);
  assert.equal(decideAmong(own, 1), true);
  const ownEdit = readPage({ url: at(111, true), texts: [`Edit listing: ${LAREDO}`], priceBox: { value: '31995' }, boxes: [{ value: `Clean Laredo.\nVIN ${VIN_A}.` }] }, mine);
  assert.equal(decideAmong(ownEdit, 2), true);
  // the VIN as a whole word only, and never one that is too short to be a VIN
  assert.equal(readPage({ url: at(111), texts: [LAREDO, '$31,995', `VIN ${VIN_A}9`] }, mine).matchesVin, false);
  assert.equal(readPage({ url: at(111), texts: [LAREDO, '$31,995', 'VIN 12345'] }, { ...mine, vin: '12345' }).matchesVin, false);
  // the VIN never stands in for the name and price, nor for Your listings
  assert.equal(decideAmong(readPage({ url: at(111), texts: [`VIN ${VIN_A}`] }, mine), 1), false);
  assert.equal(decideAmong(readPage({ url: YOURS, texts: [LAREDO, '$31,995', VIN_A] }, mine), 1), false);
  // a known id still decides alone
  assert.equal(onListing(twin, { id: '111', yourListingsUrl: YOURS, namesakes: 1 }), false);

  // what the panel says on the other unit's page
  Object.assign(up, { kind: 'price', name: LAREDO, vin: VIN_A, listedPrice: 31995 });
  try {
    assert.match(offTargetNote('', twin, 1), /Another car you posted also has 2019 Jeep Grand Cherokee Laredo in its name, so a listing counts as this car's only when its page shows this car's VIN, 1C4RJFBG5MC000001, and this page doesn't\. .*click I updated it\./);
    assert.match(offTargetNote('', twin, null), /couldn't read your posted cars/);
    assert.match(offTargetNote('', readPage({ url: YOURS, texts: ['Your listings'] }, mine), 1), /looks for its full name, \$31,995 and its VIN, 1C4RJFBG5MC000001/);
    assert.match(offTargetNote('', readPage({ url: YOURS, texts: ['Your listings'] }, mine), 0), /looks for its full name and \$31,995\)/);
  } finally {
    endUpkeep();
  }
});

// A take-down of a car the website now calls new, demo or loaner
// (src/rescan.js why 'not-pre-owned') is no sale: the panel asks for Delete,
// never Mark as sold. A sold car's take-down still offers both.
test('upkeep asks for Delete, not Mark as sold, when the car was not sold but retyped new', async () => {
  globalThis.chrome = { tabs: { create: async () => ({ id: 9 }) } };
  const ctx = { render: () => {}, map: () => FORM_MAP };
  const banner = async (why) => {
    const started = startUpkeep({ origin: 'https://www.example-motors.test', vin: 'aaa', kind: 'takeDown', why, listingUrl: 'https://www.facebook.com/marketplace/item/111/', name: 'Car A', listedPrice: 20000 }, ctx);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    up.status = 'waiting';
    const html = upkeepHtml();
    endUpkeep();
    await started;
    return /id="takeDownWaiting">(.*?)<\/div>/.exec(html)[1];
  };
  try {
    const notSold = await banner('not-pre-owned');
    assert.match(notSold, /click <b>Delete<\/b> on this listing/);
    assert.match(notSold, /do not mark it sold/);
    assert.doesNotMatch(notSold, /click <b>Mark as sold<\/b>/);
    // a sold car's take-down (drawn straight from the panel's state, without opening a tab again)
    for (const why of ['gone', 'sale-pending', '']) {
      Object.assign(up, { active: true, kind: 'takeDown', why, status: 'waiting', name: 'Car A', vin: 'AAA', error: '', note: '' });
      assert.match(/id="takeDownWaiting">(.*?)<\/div>/.exec(upkeepHtml())[1], /click <b>Mark as sold<\/b> \(or <b>Delete<\/b>\)/);
      endUpkeep();
    }
  } finally {
    endUpkeep();
    delete globalThis.chrome;
  }
});
