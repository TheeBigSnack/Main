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
import { onListing, listingIdFrom, startUpkeep, endUpkeep, up, namesakesOf, namesakesNow, offTargetNote } from '../extension/upkeep.js';
import { noteTakenDown } from '../extension/src/takenDown.js';

// A page as the reader walks it: text nodes, each inside a plain block or a
// dialog, and an optional Price box (in a dialog or on the page).
function node(tag, attrs = {}, parent = null) {
  return {
    tagName: tag.toUpperCase(), attrs, parentElement: parent, isConnected: true, id: '', value: attrs.value || '',
    getAttribute(n) { return this.attrs[n] ?? null; },
    checkVisibility() { return true; },
    getBoundingClientRect() { return { width: 100, height: 20 }; },
    matches() { return false; }, // no dropdowns on these pages
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
// A name like this car's, either way round, from any car that may still have
// a listing up: posted by this salesperson or a colleague, or taken off the
// posted list lately (the take-down record keeps the name; an older record
// without one takes it from the last scan).
test('a car whose name is in this car\'s, a colleague\'s post and a take-down all count as namesakes', async () => {
  const EXPRESS = '2019 Ram 1500 Classic Express';
  const EXPRESS_4X4 = '2019 Ram 1500 Classic Express 4x4';
  const [MINE, TWIN, OTHER] = ['1C6RR7FT0KS000001', '1C6RR7FT0KS000002', '1C6RR7FT0KS000003'];
  // this car's name holds every word of the other's: the other Ram's page shows 4x4 in its details, its name and the same price
  assert.equal(namesakesOf({ [MINE]: { name: EXPRESS_4X4 }, [TWIN]: { name: EXPRESS } }, MINE, EXPRESS_4X4), 1);
  assert.equal(namesakesOf({ [MINE]: { name: EXPRESS }, [TWIN]: { name: EXPRESS_4X4 } }, MINE, EXPRESS), 1, 'and the other way round, as before');
  const mine = { id: '', name: EXPRESS_4X4, prices: [27163], vin: MINE };
  const other = readPage({ url: at(434343), texts: [EXPRESS, '$27,163', 'Drivetrain: 4x4', `VIN ${TWIN}.`] }, mine);
  assert.deepEqual([other.matchesName, other.matchesPrice, other.matchesVin], [true, true, false], 'the other Ram\'s page reads as this car by name and price');
  assert.equal(onListing(other, { yourListingsUrl: YOURS, namesakes: namesakesOf({ [TWIN]: { name: EXPRESS } }, MINE, EXPRESS_4X4) }), false, 'so only this car\'s VIN tells them apart');
  // names that share words but where neither holds the other: not namesakes; nor a car with no name
  assert.equal(namesakesOf({ [TWIN]: { name: '2019 Ram 1500 Classic Tradesman' }, [OTHER]: { name: '' } }, MINE, EXPRESS), 0);
  assert.equal(namesakesOf({ [TWIN]: {} }, MINE, EXPRESS), 0);
  // a colleague's post, merged in by the sync
  assert.equal(namesakesOf({ [TWIN]: { name: EXPRESS, mine: false, userId: 'u2' } }, MINE, EXPRESS), 1);
  // taken off the posted list: still counted while the record keeps it, by its own name or, recorded without one, the last scan's
  const T = (h) => new Date(Date.UTC(2026, 9, 5, h)).toISOString();
  const named = noteTakenDown(null, { vin: TWIN, postedAt: T(1), name: EXPRESS }, T(2), T(2));
  assert.equal(named[0].name, EXPRESS, 'the record keeps the name');
  assert.equal(namesakesOf({}, MINE, EXPRESS, { takenDown: named }), 1);
  const unnamed = noteTakenDown(null, { vin: TWIN, postedAt: T(1) }, T(2), T(2));
  assert.equal(namesakesOf({}, MINE, EXPRESS, { takenDown: unnamed }), 0, 'with no name anywhere it is not counted');
  assert.equal(namesakesOf({}, MINE, EXPRESS, { takenDown: unnamed, names: { [TWIN]: { name: EXPRESS_4X4 } } }), 1);
  // each car once, and never this car's own take-down
  assert.equal(namesakesOf({ [TWIN]: { name: EXPRESS } }, MINE, EXPRESS, { takenDown: named }), 1);
  assert.equal(namesakesOf({}, MINE, EXPRESS, { takenDown: noteTakenDown(null, { vin: MINE, postedAt: T(1), name: EXPRESS }, T(2), T(2)) }), 0);

  // To do reads all of it from storage: the posted list, the take-down record and, for a record with no name, the last scan (once per item)
  const o = 'https://www.example-motors.test';
  const store = {
    [`posted:${o}`]: { [MINE]: { name: EXPRESS_4X4 } },
    [`takenDown:${o}`]: [...unnamed, ...noteTakenDown(null, { vin: OTHER, postedAt: T(1), name: EXPRESS }, T(3), T(3))],
    [`snapshot:${o}`]: { vehicles: { [TWIN]: { name: '2019 Ram 1500 Classic Express 4x4 Crew Cab' } } },
  };
  const asked = [];
  globalThis.chrome = { storage: { local: { get: async (keys) => { asked.push(keys); return Object.fromEntries([keys].flat().map((k) => [k, store[k]])); } } } };
  Object.assign(up, { origin: o, vin: MINE, name: EXPRESS_4X4, names: null });
  try {
    assert.equal(await namesakesNow(), 2, 'the take-down named in the record, and the one named by the last scan');
    assert.equal(await namesakesNow(), 2);
    assert.equal(asked.filter((k) => k === `snapshot:${o}`).length, 1, 'the last scan is read once');
    globalThis.chrome = { storage: { local: { get: async () => { throw new Error('no storage'); } } } };
    assert.equal(await namesakesNow(), null, 'unread: unknown');
  } finally {
    delete globalThis.chrome;
    endUpkeep();
    Object.assign(up, { origin: null, vin: null, name: '', names: null });
  }
});

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
  assert.equal(namesakesOf(posted, VIN_A, LAREDO), 3, 'the other Laredo, the Laredo E whose name holds every word of it, and the Grand whose every word is in it');
  assert.equal(namesakesOf(posted, VIN_A.toLowerCase(), LAREDO), 3, 'never itself');
  assert.equal(namesakesOf(posted, '1C4RJFBG5MC000004', LIMITED), 1, 'the Grand: the Laredos have a word the Limited lacks, and it has one they lack');
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
    assert.match(offTargetNote('', twin, 1), /Another car you posted or took down has a name like 2019 Jeep Grand Cherokee Laredo, so a listing counts as this car's only when its page shows this car's VIN, 1C4RJFBG5MC000001, and Lot Current couldn't find it in this page's text\. .*See more, click it.*click I updated it\./);
    assert.doesNotMatch(offTargetNote('', twin, 1), /this page doesn't/, 'what the reader did not find is not stated as what the page lacks');
    assert.match(offTargetNote('', twin, null), /couldn't read your posted cars/);
    assert.match(offTargetNote('', readPage({ url: YOURS, texts: ['Your listings'] }, mine), 1), /looks for its full name, \$31,995 and its VIN, 1C4RJFBG5MC000001/);
    assert.match(offTargetNote('', readPage({ url: YOURS, texts: ['Your listings'] }, mine), 0), /looks for its full name and \$31,995\)/);
  } finally {
    endUpkeep();
  }
});
