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

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readListingInPage, fillPriceInPage } from '../extension/facebook/fillForm.js';
import { LISTING_SIGNS } from '../extension/facebook/listingSigns.js';
import { FORM_MAP } from '../extension/facebook/formMap.js';
import { onListing, listingIdFrom, startUpkeep, endUpkeep, up, namesakesOf, namesakesNow, offTargetNote, unreadTabNote, upkeepHtml, handleUpkeepClick } from '../extension/upkeep.js';
import { noteTakenDown, takenDownList } from '../extension/src/takenDown.js';
import { siteKeys, GLOBAL_KEYS } from '../extension/src/storageKeys.js';
import { sessionFromTokenResponse } from '../extension/src/account.js';
import { STORAGE_FULL } from '../extension/src/storage.js';
import { fakeChrome } from './helpers.js';

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
const LIMITED_VIN = '1C4RJFBG5KC123456';
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
  // the edit form: its description box carries the car's VIN, which is what makes it this car's page
  const limitedKnown = { ...known, vin: LIMITED_VIN };
  assert.equal(decide(readPage({ url: at(111, true), texts: ['Edit listing'], priceBox: { value: '31995' }, boxes: [{ value: `VIN ${LIMITED_VIN}` }] }, limitedKnown), '111'), true);
  // an id in the address is not enough on its own: a page with neither the VIN nor the name is not this car's listing
  assert.equal(decide(readPage({ url: at(111, true), texts: ['Edit listing'], priceBox: { value: '31995' } }, known), '111'), false);

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
  const ctx = { render: () => {}, map: () => FORM_MAP, priceNow: async () => ({ ok: true, price: 19000 }) };
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

// A price update reads the car on the website again before the listing opens
// (ctx.priceNow: the side panel's upkeepPriceNow, the same read and check a
// post makes at post time) and fills the price the website shows now. A read
// that fails, a car the website no longer lists or that no longer passes the
// check, no price, or the price back at the listed one: the listing is not
// opened, nothing is filled, and the panel says why, with only Close. A
// take-down reads nothing. Not now during the read opens nothing afterwards.
test('a price update reads the car on the website again first and fills the price it shows now, or stops and says why', async () => {
  const opened = [];
  globalThis.chrome = { tabs: { create: async ({ url }) => { opened.push(url); return { id: 9 }; } } };
  const LINK = 'https://www.facebook.com/marketplace/item/111/';
  const item = { origin: 'https://www.example-motors.test', vin: 'aaa', kind: 'price', price: 19000, listingUrl: LINK, name: 'Car A', listedPrice: 20000, dealerTabId: 4 };
  const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
  const begin = async (now, req = item) => {
    opened.length = 0;
    const asked = [];
    const ctx = { render: () => {}, map: () => FORM_MAP, priceNow: async (r) => { asked.push(r); return typeof now === 'function' ? now(r) : now; } };
    const started = startUpkeep(req, ctx);
    await tick();
    const seen = { opened: [...opened], status: up.status, price: up.price, scanPrice: up.scanPrice, note: up.note, html: upkeepHtml(), asked };
    endUpkeep();
    await started;
    return seen;
  };
  try {
    // the website's price moved again since the scan: that price is filled, and the panel says the scan had found another
    const moved = await begin({ ok: true, price: 18500 });
    assert.deepEqual([moved.opened, moved.status, moved.price, moved.scanPrice], [[LINK], 'waiting', 18500, 19000]);
    assert.equal(moved.asked[0].dealerTabId, 4, 'read through the tab the To do item was clicked from');
    assert.match(moved.html, /fills in <b>\$18,500<\/b> \(was \$20,000\), the price the website shows now: Lot Current read the car on the website again just before opening the listing \(the last scan had found \$19,000\)\. Then you click <b>Update<\/b>\./);
    // the same price as the scan found
    const same = await begin({ ok: true, price: 19000 });
    assert.deepEqual([same.opened, same.price, same.scanPrice], [[LINK], 19000, null]);
    assert.doesNotMatch(same.html, /last scan had found/);
    // stops: nothing opened, nothing filled, the reason and only Close
    for (const [what, now, said] of [
      ['the read failed', { ok: false, message: "Lot Current reads this car on www.example-motors.test again before it fills a new price, and couldn't just now." }, /couldn't just now\. Nothing was filled\./],
      ['gone from the website', { ok: false, message: 'www.example-motors.test no longer lists this car, so its price was not updated.' }, /no longer lists this car/],
      ['no longer passes the check', { ok: false, message: "The website now says this is a new vehicle, so it can't go on Marketplace." }, /new vehicle/],
      ['no price', { ok: true, price: null }, /shows no price for this car right now/],
      ['back at the listed price', { ok: true, price: 20000 }, /shows \$20,000 again, the price your listing already has, so there is nothing to change on Facebook\. Nothing was filled; the next scan clears this item\./],
      ['the read threw', () => { throw new Error('offline'); }, /couldn't check this car's price on the website just now: offline/],
    ]) {
      const r = await begin(now);
      assert.deepEqual([r.opened, r.status], [[], 'stopped'], `${what}: the listing is not opened`);
      assert.match(r.note, said, what);
      assert.match(r.html, /id="upkeepStopped">[^<]*Nothing was filled/);
      assert.match(r.html, /id="upkeepClose"/);
      assert.doesNotMatch(r.html, /id="upkeepNote"/, `${what}: the reason is said once, in the banner`);
      assert.doesNotMatch(r.html, /id="upkeepDoneBtn"/, `${what}: no I updated it, which would record a price`);
    }
    // a take-down reads nothing
    const down = await begin(() => { throw new Error('a take-down must not read the price'); }, { ...item, kind: 'takeDown', price: null });
    assert.deepEqual([down.opened, down.asked.length], [[LINK], 0]);
    // while the read runs: Checking, Not now only; Not now then opens nothing
    let answer;
    const ctx = { render: () => {}, map: () => FORM_MAP, priceNow: () => new Promise((resolve) => { answer = resolve; }) };
    opened.length = 0;
    const started = startUpkeep(item, ctx);
    await tick();
    assert.equal(up.status, 'checking');
    assert.match(upkeepHtml(), /id="priceChecking"[\s\S]*id="upkeepCancel"/);
    assert.doesNotMatch(upkeepHtml(), /id="upkeepDoneBtn"/);
    assert.equal(await handleUpkeepClick('upkeepDoneBtn', { render: () => {} }), true, 'a stale I updated it records nothing');
    endUpkeep();
    answer({ ok: true, price: 18500 });
    await started;
    assert.deepEqual(opened, [], 'Not now during the read: the listing is not opened');
  } finally {
    endUpkeep();
    delete globalThis.chrome;
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

// A price update recorded from the side panel ("I updated it", or the panel
// seeing the new price) keeps the basis the read worked its price out on
// (ctx.priceNow, sidepanel.js upkeepPriceNow) on a listing that carries none
// (posted with an older version: src/rescan.js markPriceUpdated), as Updated
// in the popup does, so a switch of Price to post before the next scan is no
// part of the next price change. A listing that carries a basis keeps it.
test('a price update recorded from the side panel keeps the basis its price was read on, for a listing that carries none', async () => {
  const origin = 'https://www.example-motors.test';
  const k = siteKeys(origin);
  const record = async (entry, now) => {
    const store = { [k.posted]: { AAA: entry } };
    globalThis.chrome = { ...fakeChrome({}, store), tabs: { create: async () => ({ id: 9 }) }, runtime: { sendMessage: async () => ({}) } };
    const ctx = { render: () => {}, map: () => FORM_MAP, priceNow: async () => now };
    const started = startUpkeep({ origin, vin: 'aaa', kind: 'price', price: 27163, listingUrl: 'https://www.facebook.com/marketplace/item/111/', name: 'Car A', listedPrice: entry.price, dealerTabId: 4 }, ctx);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(up.status, 'waiting', 'the listing is open with the price to fill');
    assert.equal(await handleUpkeepClick('upkeepDoneBtn', ctx), true);
    assert.equal(up.status, 'done');
    assert.equal(up.note, 'Marked done.', 'the done banner says it was marked done by hand, not that Lot Current saw the listing change');
    endUpkeep();
    await started;
    return store[k.posted].AAA;
  };
  try {
    const older = { name: 'Car A', price: 26900, postedAt: '2026-10-02T09:00:00.000Z' };
    const kept = await record(older, { ok: true, price: 27163, basis: 'website' });
    assert.deepEqual([kept.price, kept.basis], [27163, 'website']);
    assert.ok(kept.updatedAt);
    const lower = await record(older, { ok: true, price: 26673, basis: 'beforeFees' });
    assert.deepEqual([lower.price, lower.basis], [26673, 'beforeFees']);
    const own = await record({ ...older, basis: 'beforeFees' }, { ok: true, price: 26673, basis: 'website' });
    assert.equal(own.basis, 'beforeFees', 'a listing that carries a basis keeps it');
  } finally {
    endUpkeep();
    delete globalThis.chrome;
  }
});

test('a price update whose Price box keeps another price after Lot Current\'s fills says so and asks the person to type the price', () => {
  Object.assign(up, { active: true, kind: 'price', name: 'Car A', price: 18500, listedPrice: 20000, status: 'waiting', stuck: true, boxShows: '$20,000', fills: 4 });
  const stuck = upkeepHtml();
  assert.match(stuck, /id="priceStuck"/);
  assert.match(stuck, /The Price box shows "\$20,000", not \$18,500/);
  assert.match(stuck, /Type \$18,500 in the Price box yourself, then click <b>Update<\/b>/);
  assert.doesNotMatch(stuck, /id="priceWaiting"/, 'it no longer says Lot Current will fill the price');
  // while the box has not appeared yet, the waiting text stays as it was
  Object.assign(up, { stuck: false, boxShows: '', fills: 0 });
  assert.match(upkeepHtml(), /id="priceWaiting"/);
  // stuck after fills that went in, each one undone by the form: still the stuck banner, never that the price is in the box
  Object.assign(up, { status: 'filled', filledShown: '$18,500', stuck: true, boxShows: '$20,000', fills: 4 });
  assert.match(upkeepHtml(), /id="priceStuck"/);
  assert.doesNotMatch(upkeepHtml(), /id="priceFilled"/, 'the panel never claims the price is in the box');
  endUpkeep();
});

// The price update's poll, driven on node's fake timers (the side panel's 1.5 s
// interval): the tab shows rig.page to the in-page reads, every fill is refused
// (the form keeps its own price), and each tick() runs one poll. Call endRig()
// in a finally and await rig.started after it.
const WANT_PRICE = 18500;
const LISTED_PAGE = { url: at('111'), matchesId: true, sold: false, unavailable: false, matchesVin: false, vinInText: false, matchesName: true, matchesPrice: true, prices: ['20000'], formOnPage: true, hasPriceBox: true, priceBoxValue: '20000' };
async function priceRig(page, { nextItem } = {}) {
  const rig = { page: { ...page }, fills: 0, drawn: [] }; // drawn: the panel each render draws, in order
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
  rig.flush = flush;
  rig.tick = async () => { mock.timers.tick(1500); await flush(); };
  globalThis.chrome = {
    ...fakeChrome({}, {}),
    tabs: { create: async () => ({ id: 9 }), get: async (id) => ({ id, url: rig.page.url }) },
    runtime: { sendMessage: async () => ({}) },
    scripting: {
      executeScript: async ({ func }) => {
        if (func === readListingInPage) {
          const answer = { ...rig.page }; // the page as the read finds it, whenever the answer is delivered
          if (rig.holdNextRead) {
            rig.holdNextRead = false;
            await new Promise((resolve) => { rig.release = resolve; });
          }
          return [{ result: answer }];
        }
        if (func === fillPriceInPage) {
          rig.fills += 1;
          return [{ result: { ok: false, reason: 'The Price box did not take the price.' } }];
        }
        throw new Error('an unexpected in-page script');
      },
    },
  };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const ctx = { render: () => { rig.drawn.push(upkeepHtml()); }, map: () => FORM_MAP, priceNow: async () => ({ ok: true, price: WANT_PRICE, basis: 'website' }), nextItem };
  rig.ctx = ctx;
  rig.started = startUpkeep({ origin: 'https://www.example-motors.test', vin: 'aaa', kind: 'price', price: WANT_PRICE, listingUrl: LISTED_PAGE.url, name: 'Car A', listedPrice: 20000 }, ctx);
  await flush();
  await rig.tick(); // the wait before the first poll ends
  return rig;
}
function endRig() {
  mock.timers.reset();
  endUpkeep();
  delete globalThis.chrome;
}
// the listing after Update: this car's page with its price shown and no edit form
const UPDATED_PAGE = { ...LISTED_PAGE, hasPriceBox: false, formOnPage: false, priceBoxValue: '', prices: [String(WANT_PRICE)] };

test("when the price goes down, the filled price says Facebook can let people who saved the car know, and that Lot Current doesn't", async () => {
  const rig = await priceRig(LISTED_PAGE);
  try {
    for (let i = 0; i < 5; i++) await rig.tick();
    rig.page.priceBoxValue = String(WANT_PRICE);
    await rig.tick();
    assert.equal(up.status, 'filled');
    const html = upkeepHtml();
    const banner = /<div class="banner good" id="priceFilled">[^]*?<\/div>/.exec(html);
    assert.equal(banner && banner[0], `<div class="banner good" id="priceFilled">New price $18,500 is in the Price box (it shows "18500"). Now click <b>Update</b> on Facebook. Lot Current will notice when the listing shows the new price. Facebook can let people who saved this car know about the new price; Lot Current doesn't.</div>`, 'the filled price banner, as one element: the price filled, the box as it shows it, that Lot Current will notice the new price, and the saved-car sentence');
    assert.match(html, /Facebook can let people who saved this car know about the new price; Lot Current doesn't\./);
    assert.doesNotMatch(html, /Lot Current (tells|notifies|will tell|will notify) (anyone|people|them)/);
  } finally {
    endRig();
    await rig.started;
  }
});

test('when the price goes up, the filled price says nothing about the people who saved the car', async () => {
  const rig = await priceRig(LISTED_PAGE);
  try {
    for (let i = 0; i < 5; i++) await rig.tick();
    rig.page.priceBoxValue = String(WANT_PRICE);
    await rig.tick();
    assert.equal(up.status, 'filled');
    Object.assign(up, { listedPrice: 15000 }); // the listing showed less than the new price
    assert.doesNotMatch(upkeepHtml(), /saved this car|Lot Current doesn't/);
  } finally {
    endRig();
    await rig.started;
  }
});

// Once Lot Current has filled four times and the Price box still keeps another
// price, the banner says so and stops filling. A price the person then types
// into the box by hand must clear that banner and make the item filled, so that
// Update closes it once the listing shows the new price.

test('a price typed by hand after Lot Current stops filling clears the stuck banner, and Update then closes the item', async () => {
  const rig = await priceRig(LISTED_PAGE);
  try {
    for (let i = 0; i < 5; i++) await rig.tick(); // four fills, then the box is seen to keep its price
    assert.equal(rig.fills, 4, 'Lot Current fills four times');
    assert.equal(up.stuck, true, 'then the banner says the box keeps another price');
    assert.equal(up.status, 'waiting', 'and nothing was filled, so the item is still waiting');
    rig.page.priceBoxValue = String(WANT_PRICE); // the person types the price into the box by hand
    await rig.tick();
    assert.equal(up.stuck, false, 'a price typed by hand clears the stuck banner');
    assert.equal(up.status, 'filled', 'and the item is filled, so Update can close it');
    assert.match(upkeepHtml(), /id="priceFilled"/);
    assert.equal(rig.fills, 4, 'no further fill: the box has the price');
    rig.page = { ...UPDATED_PAGE }; // the person clicks Update
    await rig.tick();
    assert.equal(up.status, 'done', 'the listing shows the new price, so the item closes');
    assert.equal(up.error, '');
  } finally {
    endRig();
    await rig.started;
  }
});

// The same when the person types the price before Lot Current has filled at all.
test('a price typed by hand before any fill is filled, and Update closes the item', async () => {
  const rig = await priceRig({ ...LISTED_PAGE, priceBoxValue: String(WANT_PRICE) });
  try {
    await rig.tick(); // the first poll reads the box with the price in it
    assert.equal(rig.fills, 0, 'no fill: the box has the price');
    assert.equal(up.status, 'filled', 'the item is filled, so Update can close it');
    rig.page = { ...UPDATED_PAGE };
    await rig.tick();
    assert.equal(up.status, 'done', 'the listing shows the new price, so the item closes');
  } finally {
    endRig();
    await rig.started;
  }
});

// When Chrome cannot open the listing tab, the panel says so and asks for the listing to be opened by hand;
// it does not show the waiting banner, which says Lot Current will fill the form once Edit listing is clicked.
test('when Chrome cannot open the listing tab, upkeep says so and asks for the listing to be opened by hand, with no waiting banner', async () => {
  globalThis.chrome = { tabs: { create: async () => { throw new Error('no tab for you'); } } };
  const ctx = { render: () => {}, map: () => FORM_MAP, priceNow: async () => ({ ok: true, price: 19000 }) };
  try {
    await startUpkeep({ origin: 'https://www.example-motors.test', vin: 'aaa', kind: 'price', price: 19000, listingUrl: 'https://www.facebook.com/marketplace/item/111/', name: 'Car A', listedPrice: 20000 }, ctx);
    assert.equal(up.status, 'open-failed');
    const html = upkeepHtml();
    assert.match(html, /Couldn&#39;t open the listing: no tab for you/, 'the error shows (escaped)');
    assert.doesNotMatch(html, /priceWaiting|takeDownWaiting/, 'no waiting banner');
    assert.match(html, /id="upkeepOpenFailed"[^>]*>Open the listing yourself, with the link above, and change the price there by hand\. Then click <b>I updated it<\/b>\./);
    assert.match(html, /id="upkeepDoneBtn"/, 'the person can still say it is done');
    up.kind = 'takedown';
    assert.match(upkeepHtml(), /Open the listing yourself, with the link above, and click Mark as sold or Delete there\. Then click <b>I took it down<\/b>\./);
  } finally {
    endUpkeep();
    delete globalThis.chrome;
  }
});

// What the poll says when the listing tab cannot be read (upkeep.js poll): a tab that has moved off Marketplace is said so,
// because Lot Current reads a listing only on a Marketplace page; on a Marketplace page the read is simply tried again;
// with no address to see (Chrome hides it outside the Marketplace permission), it says the tab may have moved.
test('a listing tab that has moved off Marketplace is said so; one still on Marketplace is tried again; one with no address is said to maybe have moved', () => {
  const name = '2019 Ram 1500 Classic';
  const moved = unreadTabNote('https://www.facebook.com/home', name);
  assert.match(moved, /^The listing tab isn't on Facebook Marketplace any more, so Lot Current can't read the listing for 2019 Ram 1500 Classic\./);
  assert.match(moved, /Open that listing again and it continues\.$/);
  assert.equal(unreadTabNote('https://www.facebook.com/marketplace/item/123/', name), '', 'on Marketplace, nothing is said: the next read tries again');
  assert.match(unreadTabNote(undefined, name), /^The listing tab may have moved off Facebook Marketplace, so Lot Current can't read the listing for 2019 Ram 1500 Classic right now\./);
});

// The open-failed hint (upkeepHtml): with a saved listing link it says the link above; with none, the link is not drawn, so the
// hint names Your listings and the car in it instead (the link above is then no link at all).
test('an open-failed listing with no saved link says to open it from Your listings, not from a link above', () => {
  const failed = { status: 'open-failed', vin: 'VIN1', name: '2019 Ram 1500 Classic', error: "Couldn't open the listing: no tab", note: '', why: '', listedPrice: null, price: 19995, listingUrl: '' };
  Object.assign(up, { ...failed, kind: 'price' });
  const bare = upkeepHtml();
  assert.match(bare, /id="upkeepOpenFailed"[^>]*>Open the listing yourself, from Your listings on Marketplace \(2019 Ram 1500 Classic is there\), and change the price there by hand\./);
  assert.doesNotMatch(bare, /with the link above/, 'no link is drawn above, so none is named');
  Object.assign(up, { kind: 'takeDown' });
  assert.match(upkeepHtml(), /Open the listing yourself, from Your listings on Marketplace \(2019 Ram 1500 Classic is there\), and click Mark as sold or Delete there\./);
  Object.assign(up, { kind: 'price', listingUrl: 'https://www.facebook.com/marketplace/item/123/' });
  assert.match(upkeepHtml(), /Open the listing yourself, with the link above, and change the price there by hand\./, 'with a saved link, the link above is named');
  Object.assign(up, { status: 'idle', error: '', listingUrl: '' });
});

// Open next To do item (upkeep.js): an item that is done offers the next To do
// item when ctx.nextItem has one (the side panel reads the lists as they are
// stored: sidepanel.js nextUpkeepRequest). The button starts that item, which
// only opens its listing: nothing on Facebook is clicked for the person.
const noop = () => {};
const NEXT = { origin: 'https://www.example-motors.test', vin: 'BBB', kind: 'takeDown', why: 'gone', price: null, listingUrl: 'https://www.facebook.com/marketplace/item/222/', name: 'Car B', listedPrice: 21000, dealerTabId: null, windowId: null, at: 1 };
const DONE_CAR = { active: true, origin: 'https://www.example-motors.test', vin: 'AAA', kind: 'takeDown', why: 'gone', status: 'done', note: 'Marked done.', name: 'Car A', listingUrl: '', listedPrice: null, hasNext: false, error: '' };

test('the Open next To do item button is drawn only when the item is done and another one follows', () => {
  Object.assign(up, { ...DONE_CAR, hasNext: true });
  try {
    assert.match(upkeepHtml(), /<button type="button" class="primary" id="upkeepNext">Open next To do item<\/button>/);
    assert.match(upkeepHtml(), /<button type="button" class="plain" id="upkeepClose">Close<\/button>/, 'Close is kept beside it');
    assert.match(upkeepHtml(), /<div class="actions"><button type="button" class="primary" id="upkeepNext">Open next To do item<\/button><button type="button" class="plain" id="upkeepClose">Close<\/button><\/div>/, 'Open next To do item leads the row, and Close follows it');
    up.hasNext = false;
    assert.doesNotMatch(upkeepHtml(), /upkeepNext/, 'no next item, no button');
    Object.assign(up, { hasNext: true, status: 'waiting' });
    assert.doesNotMatch(upkeepHtml(), /upkeepNext/, 'an item not done yet offers none');
    Object.assign(up, { hasNext: true, status: 'stopped', note: 'The website shows no price for this car right now, so there is no price to fill. Nothing was filled.' });
    assert.doesNotMatch(upkeepHtml(), /upkeepNext/, 'a stopped item offers none');
  } finally {
    endUpkeep();
  }
});

test('Open next To do item asks for the next item once, and starts it: its listing opens, and nothing is clicked', async () => {
  const opened = [];
  let asked = 0;
  globalThis.chrome = { tabs: { create: async ({ url }) => { opened.push(url); return { id: 31 }; } } };
  const ctx = { render: noop, map: () => FORM_MAP, nextItem: async () => { asked += 1; return NEXT; }, onClose: noop };
  try {
    Object.assign(up, { ...DONE_CAR, hasNext: true });
    assert.equal(await handleUpkeepClick('upkeepNext', ctx), true);
    assert.equal(asked, 1, 'the next item is asked for once');
    assert.deepEqual([up.vin, up.kind, up.name, up.status, up.hasNext], ['BBB', 'takeDown', 'Car B', 'waiting', false]);
    assert.deepEqual(opened, [NEXT.listingUrl], 'only that item\'s listing is opened');
  } finally {
    endUpkeep();
    delete globalThis.chrome;
  }
});

test('a second Open next To do item click while the next item is being found starts nothing', async () => {
  let asked = 0;
  let answer = null;
  const drawn = []; // the HTML each render draws, in order, and the To do list when the panel goes back to it (sidepanel.js onClose)
  const ctx = { render: () => { drawn.push(upkeepHtml()); }, map: () => FORM_MAP, nextItem: () => { asked += 1; return new Promise((resolve) => { answer = resolve; }); }, onClose: () => { drawn.push('the To do list'); } };
  try {
    Object.assign(up, { ...DONE_CAR, hasNext: true });
    const first = handleUpkeepClick('upkeepNext', ctx);
    assert.equal(up.status, 'finding', 'the status turns to finding before anything is awaited');
    assert.match(upkeepHtml(), /<p class="hint" id="upkeepFinding">Finding the next To do item…<\/p>/, 'the lookup line, whole');
    assert.doesNotMatch(upkeepHtml(), /upkeepNext/, 'the button is not drawn while the next item is found');
    assert.match(upkeepHtml(), /id="upkeepClose"/, 'Close is the one button drawn while the next item is found');
    assert.doesNotMatch(upkeepHtml(), /upkeepDoneBtn|upkeepCancel/, 'no I took it down or Not now while the next item is found');
    assert.doesNotMatch(upkeepHtml(), /upkeepNote|Marked done\./, 'the done note is not repeated under the finding line');
    const lookupDrawn = drawn.find((html) => /<p class="hint" id="upkeepFinding">Finding the next To do item…<\/p>/.test(html));
    assert.ok(lookupDrawn, 'a render drew the lookup line while the lookup is held');
    assert.match(lookupDrawn, /id="upkeepClose">Close<\/button>/, 'Close is drawn in that render');
    assert.doesNotMatch(lookupDrawn, /id="upkeepNext"/, 'the Open next To do item button is not drawn in that render');
    assert.match(drawn.at(-1), /<p class="hint" id="upkeepFinding">Finding the next To do item…<\/p>/, 'the last render while the lookup is held is still the lookup line');
    const below = (html) => html.slice(html.indexOf('</section>')); // the panel under the car's name and VIN
    const second = handleUpkeepClick('upkeepNext', ctx);
    assert.equal(asked, 1, 'the second click asks for nothing');
    assert.equal(drawn.includes('the To do list'), false, 'nor does it, or the lookup, take the panel back to the To do list: the Finding line and Close stay drawn');
    assert.equal(await second, true);
    answer(null);
    assert.equal(await first, true);
    assert.equal(up.status, 'done', 'no item came back: the done banner is restored');
    assert.equal(up.hasNext, false);
    // a done price update's lookup draws the same panel: the Finding line and Close alone, in the last render while it is held
    Object.assign(up, { ...DONE_CAR, kind: 'price', why: '', price: 19000, listedPrice: 20000, hasNext: true });
    const priceLookup = handleUpkeepClick('upkeepNext', ctx);
    assert.match(drawn.at(-1), /<p class="hint" id="upkeepFinding">Finding the next To do item…<\/p>\s*<div class="actions"><button type="button" class="\w+" id="upkeepClose">Close<\/button><\/div>/, 'a done price update\'s lookup draws the Finding line and Close alone');
    const priceSecond = handleUpkeepClick('upkeepNext', ctx);
    assert.equal(asked, 2, 'a second click on a price update\'s lookup asks for nothing either');
    assert.equal(await priceSecond, true);
    answer(null);
    assert.equal(await priceLookup, true);
    // and so does one Lot Current saw saved: the note its done banner gave is not drawn under the Finding line either
    Object.assign(up, { ...DONE_CAR, kind: 'price', why: '', price: 19000, listedPrice: 20000, note: 'The listing now shows $19,000.', hasNext: true });
    const seenLookup = handleUpkeepClick('upkeepNext', ctx);
    assert.match(drawn.at(-1), /<p class="hint" id="upkeepFinding">Finding the next To do item…<\/p>\s*<div class="actions"><button type="button" class="\w+" id="upkeepClose">Close<\/button><\/div>/, 'a price update Lot Current saw saved draws the Finding line and Close alone');
    assert.equal(below(drawn.at(-1)), below(lookupDrawn), 'the same panel as the take-down\'s lookup: no done banner over the Finding line, and the same Close');
    answer(null);
    assert.equal(await seenLookup, true);
    // the whole panel under the car's name, so a line added between the banner and the buttons is caught too; it locks in the
    // done note drawn twice (HANDOFF 34.4), so a fix to that changes this pin too
    assert.equal(below(drawn.at(-1)), [
      '</section>',
      '    <div class="banner good" id="upkeepDone">Done. The listing now shows $19,000.</div><p class="hint" id="upkeepNote">The listing now shows $19,000.</p>',
      '    <div class="actions"><button type="button" class="primary" id="upkeepClose">Close</button></div>',
      '    <p class="hint">Lot Current fills in the price and reads the page; you click Edit, Update, Mark as sold or Delete. It never clicks those for you.</p>',
    ].join('\n'), 'no item came back: the done banner keeps the note Lot Current saw');
    // and so does one finished by hand after the Price box kept another price, with its tab moved off the listing: neither
    // the stuck banner nor the done note is drawn over the lookup
    Object.assign(up, { ...DONE_CAR, kind: 'price', why: '', price: 19000, listedPrice: 20000, stuck: true, boxShows: '$20,000', offTarget: true, hasNext: true });
    const stuckLookup = handleUpkeepClick('upkeepNext', ctx);
    assert.match(drawn.at(-1), /<p class="hint" id="upkeepFinding">Finding the next To do item…<\/p>\s*<div class="actions"><button type="button" class="\w+" id="upkeepClose">Close<\/button><\/div>/, 'a price update finished while its fill was stuck draws the Finding line and Close alone');
    assert.equal(below(drawn.at(-1)), below(lookupDrawn), 'the same panel as the take-down\'s lookup: no stuck banner over the Finding line, and the same Close');
    answer(null);
    assert.equal(await stuckLookup, true);
    assert.match(drawn.at(-1), /<div class="banner good" id="upkeepDone">Done\. Marked done\.<\/div>/, 'no item came back: the done banner is drawn last, not the stuck banner');
    Object.assign(up, { stuck: false, boxShows: '', offTarget: false });
    // and so does a take-down Lot Current saw sold: the note its done banner gave is not drawn under the Finding line
    Object.assign(up, { ...DONE_CAR, note: 'The listing shows it as sold or removed.', hasNext: true });
    const soldLookup = handleUpkeepClick('upkeepNext', ctx);
    assert.match(drawn.at(-1), /<p class="hint" id="upkeepFinding">Finding the next To do item…<\/p>\s*<div class="actions"><button type="button" class="\w+" id="upkeepClose">Close<\/button><\/div>/, 'a take-down Lot Current saw sold draws the Finding line and Close alone');
    answer(null);
    assert.equal(await soldLookup, true);
  } finally {
    endUpkeep();
  }
});

// A read that answers after the item is finished, or while the next To do item is looked for, sets nothing on the
// panel: a done item stays done, and the lookup's answer is not dropped. (A read that fails because the tab closed
// is a different case, pinned by the race tests above.)
test('a price read still in flight when I updated it does not reopen the done item as filled', async () => {
  const NEXT = { origin: 'https://www.example-motors.test', vin: 'bbb', kind: 'price', price: 15000, listingUrl: at('222'), name: 'Car B', listedPrice: 15500 };
  const rig = await priceRig(LISTED_PAGE, { nextItem: async () => NEXT });
  try {
    for (let i = 0; i < 6; i += 1) await rig.tick(); // four fills the form refuses, then the box is stuck
    assert.equal(up.stuck, true, 'the Price box keeps the listed price, so the item is stuck');
    // the person types the new price, and the next read is in flight with it in its answer
    rig.page.priceBoxValue = String(WANT_PRICE);
    rig.holdNextRead = true;
    await rig.tick();
    assert.equal(typeof rig.release, 'function', 'the read is in flight');
    assert.equal(await handleUpkeepClick('upkeepDoneBtn', rig.ctx), true);
    assert.equal(up.status, 'done');
    assert.equal(up.hasNext, true);
    rig.release();
    await rig.flush();
    assert.equal(up.status, 'done', 'the late answer does not change the done item');
    assert.match(upkeepHtml(), /id="upkeepNext"/, 'Open next To do item is still offered');
    assert.match(rig.drawn.at(-1), /id="upkeepNext"/, 'and the last panel drawn offers it');
    assert.doesNotMatch(upkeepHtml(), /id="priceFilled"/, 'and the item is not drawn as filled');
    // a car with no saved link reads the posted list after the page, and that read answering after I updated it sets
    // nothing either, also on a done item with no next item to offer: the done banner keeps its note
    rig.ctx.nextItem = async () => null;
    rig.page = { ...LISTED_PAGE, url: FORM_MAP.yourListingsUrl, matchesId: false }; // the tab opens on Your listings
    const noLink = startUpkeep({ origin: 'https://www.example-motors.test', vin: 'ccc', kind: 'price', price: WANT_PRICE, listingUrl: '', name: 'Car C', listedPrice: 20000 }, rig.ctx);
    await rig.flush();
    await rig.tick(); // the wait before the first poll ends
    await noLink;
    const get = chrome.storage.local.get;
    let answerList = null;
    chrome.storage.local.get = (keys) => (Array.isArray(keys) ? new Promise((resolve) => { answerList = () => get(keys).then(resolve); }) : get(keys));
    await rig.tick(); // the poll reads the page, then waits on the posted list
    assert.equal(typeof answerList, 'function', 'the posted list is being read');
    assert.equal(await handleUpkeepClick('upkeepDoneBtn', rig.ctx), true);
    answerList();
    await rig.flush();
    assert.match(rig.drawn.at(-1), /<div class="banner good" id="upkeepDone">Done\. Marked done\.<\/div>/, 'the posted list answering after I updated it leaves the done banner and its note');
  } finally {
    endRig();
  }
});

test('a price read still in flight while the next To do item is looked for does not drop the lookup: the item it finds opens', async () => {
  const NEXT = { origin: 'https://www.example-motors.test', vin: 'bbb', kind: 'price', price: 15000, listingUrl: at('222'), name: 'Car B', listedPrice: 15500 };
  let answer = null;
  let lookupHeld = false;
  const rig = await priceRig(LISTED_PAGE, { nextItem: () => (lookupHeld ? new Promise((resolve) => { answer = resolve; }) : Promise.resolve(NEXT)) });
  try {
    for (let i = 0; i < 6; i += 1) await rig.tick();
    assert.equal(up.stuck, true, 'the Price box keeps the listed price, so the item is stuck');
    rig.page.priceBoxValue = String(WANT_PRICE);
    rig.holdNextRead = true;
    await rig.tick();
    assert.equal(await handleUpkeepClick('upkeepDoneBtn', rig.ctx), true);
    assert.equal(up.status, 'done');
    lookupHeld = true;
    // not awaited: the item the lookup opens waits on its own 1.5 s timer, which these fake timers run only on a tick
    handleUpkeepClick('upkeepNext', rig.ctx);
    assert.equal(up.status, 'finding', 'the next item is being looked for');
    rig.release();
    await rig.flush();
    assert.equal(up.status, 'finding', 'the late answer does not change the lookup');
    answer(NEXT);
    await rig.flush();
    assert.equal(up.vin, 'BBB', 'the item the lookup found opens');
    // a car with no saved link reads the posted list after the page, and that read answering while the next item is
    // looked for sets nothing either: the done banner an empty lookup brings back keeps its note
    lookupHeld = false;
    rig.page = { ...LISTED_PAGE, url: FORM_MAP.yourListingsUrl, matchesId: false }; // the tab opens on Your listings
    const noLink = startUpkeep({ origin: 'https://www.example-motors.test', vin: 'ccc', kind: 'price', price: WANT_PRICE, listingUrl: '', name: 'Car C', listedPrice: 20000 }, rig.ctx);
    await rig.flush();
    await rig.tick(); // the wait before the first poll ends
    await noLink;
    const get = chrome.storage.local.get;
    let answerList = null;
    chrome.storage.local.get = (keys) => (Array.isArray(keys) ? new Promise((resolve) => { answerList = () => get(keys).then(resolve); }) : get(keys));
    await rig.tick(); // the poll reads the page, then waits on the posted list
    assert.equal(typeof answerList, 'function', 'the posted list is being read');
    assert.equal(await handleUpkeepClick('upkeepDoneBtn', rig.ctx), true);
    lookupHeld = true;
    const lookup = handleUpkeepClick('upkeepNext', rig.ctx);
    answerList();
    await rig.flush();
    answer(null);
    assert.equal(await lookup, true);
    assert.match(rig.drawn.at(-1), /<div class="banner good" id="upkeepDone">Done\. Marked done\.<\/div>/, 'the posted list answering during the lookup leaves the done banner its note');
  } finally {
    endRig();
  }
});

test('Close while the next item is being found: the late answer opens no listing, and Close is the button that works then', async () => {
  const opened = [];
  let answer = null;
  globalThis.chrome = { tabs: { create: async ({ url }) => { opened.push(url); return { id: 31 }; } } };
  const ctx = { render: noop, map: () => FORM_MAP, nextItem: () => new Promise((resolve) => { answer = resolve; }), onClose: noop };
  try {
    Object.assign(up, { ...DONE_CAR, hasNext: true });
    const first = handleUpkeepClick('upkeepNext', ctx);
    assert.equal(up.status, 'finding');
    assert.equal(await handleUpkeepClick('upkeepClose', ctx), true, 'Close closes the tab\'s item while the next one is found');
    answer(NEXT);
    assert.equal(await first, true);
    assert.deepEqual(opened, [], 'the late answer after Close opens no listing');
    assert.equal(up.active, false);
  } finally {
    endUpkeep();
    delete globalThis.chrome;
  }
});

test('an item the popup opens while the next one is found is not replaced by the late answer', async () => {
  const opened = [];
  let answer = null;
  globalThis.chrome = { tabs: { create: async ({ url }) => { opened.push(url); return { id: 32 }; } }, runtime: { sendMessage: async () => ({}) } };
  const ctx = { render: noop, map: () => FORM_MAP, nextItem: () => new Promise((resolve) => { answer = resolve; }), onClose: noop };
  const OPENED = { ...NEXT, vin: 'CCC', name: 'Car C', listingUrl: 'https://www.facebook.com/marketplace/item/333/' };
  try {
    Object.assign(up, { ...DONE_CAR, hasNext: true });
    const first = handleUpkeepClick('upkeepNext', ctx);
    await startUpkeep(OPENED, ctx);
    answer(NEXT);
    assert.equal(await first, true);
    assert.equal(up.vin, 'CCC', 'the item the popup opened stays');
    assert.deepEqual(opened, [OPENED.listingUrl], 'only that listing opened');
  } finally {
    endUpkeep();
    delete globalThis.chrome;
  }
});

test('Close while Lot Current looks for the next item after an item is done: the late answer shows no Next button', async () => {
  const origin = 'https://www.example-motors.test';
  const k = siteKeys(origin);
  const store = { [k.posted]: { AAA: { price: 20000, postedAt: 1, mine: true, name: 'Car A' } } };
  let answer = null;
  globalThis.chrome = { ...fakeChrome({}, store), tabs: { create: async () => ({ id: 33 }) }, runtime: { sendMessage: async () => ({}) } };
  const ctx = { render: noop, map: () => FORM_MAP, nextItem: () => new Promise((resolve) => { answer = resolve; }), onClose: noop };
  try {
    Object.assign(up, { ...DONE_CAR, status: 'waiting', hasNext: false });
    const done = handleUpkeepClick('upkeepDoneBtn', ctx);
    for (let i = 0; i < 50 && !answer; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(up.status, 'done', 'the done banner is drawn while the next item is looked up');
    assert.equal(await handleUpkeepClick('upkeepClose', ctx), true);
    answer(NEXT);
    assert.equal(await done, true);
    assert.equal(up.hasNext, false, 'the late answer after Close sets no Next button');
  } finally {
    endUpkeep();
    delete globalThis.chrome;
  }
});

test('when no To do item is left, the done banner stays and no Next button is drawn', async () => {
  const drawn = []; // the HTML each render draws, in order, and the To do list when the panel goes back to it (sidepanel.js onClose)
  const ctx = { render: () => { drawn.push(upkeepHtml()); }, map: () => FORM_MAP, nextItem: async () => null, onClose: () => { drawn.push('the To do list'); } };
  try {
    Object.assign(up, { ...DONE_CAR, hasNext: true });
    assert.equal(await handleUpkeepClick('upkeepNext', ctx), true);
    assert.equal(up.status, 'done');
    assert.equal(up.hasNext, false);
    const html = upkeepHtml();
    assert.match(html, /id="upkeepDone"/);
    assert.doesNotMatch(html, /upkeepNext/);
    assert.match(html, /id="upkeepClose"/);
    assert.match(drawn.at(-1), /<div class="banner good" id="upkeepDone">Done\. Marked done\.<\/div>/, 'the panel is drawn again with the done banner, its note kept');
    assert.doesNotMatch(drawn.at(-1), /id="upkeepNext"/, 'and that last panel offers no Open next To do item');
    assert.equal(drawn.includes('the To do list'), false, 'and the panel never went back to the To do list on the way');
    // a note Lot Current saw on the listing is kept the same way, not put back as Marked done.
    Object.assign(up, { ...DONE_CAR, note: 'The listing shows it as sold or removed.', hasNext: true });
    assert.equal(await handleUpkeepClick('upkeepNext', ctx), true);
    assert.match(drawn.at(-1), /<div class="banner good" id="upkeepDone">Done\. The listing shows it as sold or removed\.<\/div>/, 'the done banner keeps the note Lot Current saw');
  } finally {
    endUpkeep();
  }
});

test('when the next To do item cannot be found, the done banner stays and no Next button is drawn', async () => {
  const drawn = []; // the HTML each render draws, in order, and the To do list when the panel goes back to it (sidepanel.js onClose)
  const ctx = { render: () => { drawn.push(upkeepHtml()); }, map: () => FORM_MAP, nextItem: async () => { throw new Error('storage is unavailable'); }, onClose: () => { drawn.push('the To do list'); } };
  try {
    Object.assign(up, { ...DONE_CAR, hasNext: true });
    assert.equal(await handleUpkeepClick('upkeepNext', ctx), true);
    assert.equal(up.status, 'done');
    assert.equal(up.hasNext, false);
    assert.match(upkeepHtml(), /id="upkeepDone"/);
    assert.doesNotMatch(upkeepHtml(), /upkeepNext/);
    assert.match(drawn.at(-1), /<div class="banner good" id="upkeepDone">Done\. Marked done\.<\/div>/, 'the panel is drawn again with the done banner, its note kept');
    assert.equal(drawn.includes('the To do list'), false, 'and the panel never went back to the To do list on the way');
    // a note Lot Current saw on the listing is kept the same way when the lookup fails, not put back as Marked done.
    Object.assign(up, { ...DONE_CAR, note: 'The listing shows it as sold or removed.', hasNext: true });
    assert.equal(await handleUpkeepClick('upkeepNext', ctx), true);
    assert.match(drawn.at(-1), /<div class="banner good" id="upkeepDone">Done\. The listing shows it as sold or removed\.<\/div>/, 'after a failed lookup the done banner keeps the note Lot Current saw');
    // and so is the note of a price update Lot Current saw saved
    Object.assign(up, { ...DONE_CAR, kind: 'price', why: '', price: 19000, listedPrice: 20000, note: 'The listing now shows $19,000.', hasNext: true });
    assert.equal(await handleUpkeepClick('upkeepNext', ctx), true);
    assert.match(drawn.at(-1), /<div class="banner good" id="upkeepDone">Done\. The listing now shows \$19,000\.<\/div>/, 'after a failed lookup a price update\'s done banner keeps the note Lot Current saw');
  } finally {
    endUpkeep();
  }
});

// The next item is started the way any item is (startUpkeep): a price update
// reads the car on the website before its listing opens, so the price filled
// is the website's now, and a read that says no opens nothing and stops with
// the reason.
test('Open next To do item on a price update reads the car on the website before its listing opens, and opens no listing when that read says no', async () => {
  const opened = [];
  globalThis.chrome = { tabs: { create: async ({ url }) => { opened.push(url); return { id: 12 }; } } };
  const NEXT_PRICE = { origin: 'https://www.example-motors.test', vin: 'CCC', kind: 'price', why: '', price: 18000, listingUrl: 'https://www.facebook.com/marketplace/item/333/', name: 'Car C', listedPrice: 20000, dealerTabId: null, windowId: null, at: 1 };
  try {
    const asked = [];
    const readBeforeTab = [];
    const drawn = []; // the status each render draws, in order
    const panels = []; // and the panel it draws
    const ctx = {
      render: () => { drawn.push(up.status); panels.push(upkeepHtml()); },
      map: () => FORM_MAP,
      nextItem: async () => NEXT_PRICE,
      priceNow: async (req) => { asked.push(req.vin); readBeforeTab.push(opened.length); return { ok: true, price: 17500, basis: 'website' }; },
      onClose: noop,
    };
    Object.assign(up, { ...DONE_CAR, hasNext: true });
    assert.equal(await handleUpkeepClick('upkeepNext', ctx), true);
    assert.deepEqual(asked, ['CCC'], 'the car is read on the website once');
    assert.deepEqual(readBeforeTab, [0], 'the read comes before the listing tab is created');
    assert.deepEqual(opened, [NEXT_PRICE.listingUrl], 'then that listing opens');
    assert.deepEqual([up.vin, up.kind, up.price, up.scanPrice], ['CCC', 'price', 17500, 18000], 'the price filled is the website\'s now, and the scan\'s is kept beside it');
    assert.deepEqual(drawn, ['finding', 'checking', 'opening', 'waiting'], 'the panel goes from the lookup line to the price check, and never draws the next car as done');
    assert.match(panels[2], /<p>Opening your listing…<\/p>/, 'while its listing opens, the panel says so, before it gives any step on Facebook');
    endUpkeep();

    const stopped = [];
    globalThis.chrome = { tabs: { create: async ({ url }) => { stopped.push(url); return { id: 13 }; } } };
    const refused = { ...ctx, priceNow: async () => ({ ok: false, message: 'Lot Current couldn\'t check this car\'s price on the website just now.' }) };
    Object.assign(up, { ...DONE_CAR, hasNext: true });
    assert.equal(await handleUpkeepClick('upkeepNext', refused), true);
    assert.equal(up.status, 'stopped', 'the read said no: the item stops');
    assert.equal(up.note, 'Lot Current couldn\'t check this car\'s price on the website just now. Nothing was filled.');
    assert.deepEqual(stopped, [], 'and no listing tab is opened');
  } finally {
    endUpkeep();
    delete globalThis.chrome;
  }
});

// Finishing an item asks the same question (finish): the done banner gets the
// button when another item follows, and keeps its plain Close when none does or
// the question fails. I updated it is clicked here, so the click's answer waits
// for the question (finish awaits it) and the panel is settled when it resolves.
test('finishing an item offers Open next To do item only when another item follows', async () => {
  const cases = [
    [async () => NEXT, true],
    [async () => null, false],
    [async () => { throw new Error('storage is unavailable'); }, false],
  ];
  for (const [nextItem, offered] of cases) {
    const rig = await priceRig(LISTED_PAGE, { nextItem });
    try {
      for (let i = 0; i < 5; i++) await rig.tick();
      rig.page.priceBoxValue = String(WANT_PRICE);
      await rig.tick();
      assert.equal(up.status, 'filled');
      assert.equal(await handleUpkeepClick('upkeepDoneBtn', rig.ctx), true);
      assert.equal(up.status, 'done');
      assert.equal(up.hasNext, offered, `another item follows: ${offered}`);
      assert.match(upkeepHtml(), /id="upkeepDone"/, 'the done banner shows');
      assert.match(rig.drawn.at(-1), /<div class="banner good" id="upkeepDone">Done\. Marked done\.<\/div>/, 'it is the last panel drawn');
      assert.equal(/id="upkeepNext"/.test(upkeepHtml()), offered, `button drawn: ${offered}`);
      assert.equal(/id="upkeepNext"/.test(rig.drawn.at(-1)), offered, `and in the last panel drawn: ${offered}`);
    } finally {
      endRig();
      await rig.started;
    }
  }
});

// The poll that reads the listing, on the side panel's 1.5 s interval. A read
// can be held: the poll then waits in flight, as it does on a slow page, until
// the test answers it. stopPolling stops the interval, not a poll already in
// flight. finish's stopPolling leaves such a poll to write the status when its
// read answers, since it is still the same item's. startUpkeep and endUpkeep
// change `starts` (endUpkeep clears `active` too), so a poll still in flight
// when another To do item starts, or Not now is pressed, writes no status,
// note or listing for the item then shown.
async function raceRig(item, store = {}) {
  const r = { tabGone: false, tabUrl: LISTED_PAGE.url, holdRead: false, heldRead: null, lookups: [], drawn: [], messages: [] };
  r.flush = async () => { for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve)); };
  r.tick = async () => { mock.timers.tick(1500); await r.flush(); };
  r.untilLookups = async (n) => { for (let i = 0; i < 200 && r.lookups.length < n; i++) await new Promise((resolve) => setImmediate(resolve)); };
  globalThis.chrome = {
    ...fakeChrome({}, store),
    tabs: { create: async () => ({ id: 9 }), get: async (id) => { if (r.tabGone) throw new Error('No tab with id: 9'); return { id, url: r.tabUrl }; } },
    runtime: { sendMessage: async (msg) => { r.messages.push(msg); return {}; } },
    scripting: {
      executeScript: async ({ func }) => {
        if (func !== readListingInPage) throw new Error('an unexpected in-page script');
        if (!r.holdRead) return [{ result: { ...LISTED_PAGE } }];
        r.holdRead = false;
        return new Promise((resolve, reject) => { r.heldRead = { fail: reject, answer: resolve }; });
      },
    },
  };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  r.ctx = { render: () => { r.drawn.push(upkeepHtml()); }, map: () => FORM_MAP, priceNow: async () => ({ ok: true, price: WANT_PRICE, basis: 'website' }), nextItem: () => new Promise((resolve) => { r.lookups.push(resolve); }) };
  r.started = startUpkeep(item, r.ctx);
  await r.flush();
  await r.tick(); // the wait before the first poll ends
  return r;
}
function endRaceRig(r) {
  mock.timers.reset();
  endUpkeep();
  delete globalThis.chrome;
  return r.started;
}
const RACE_NEXT = { origin: 'https://www.example-motors.test', vin: 'BBB', kind: 'takeDown', why: 'gone', price: null, listingUrl: at('222'), name: 'Car B', listedPrice: 21000 };

test('a read still in flight when I updated it answers after the tab has closed, during the next-item lookup: the item reads as gone and offers no Open next To do item', async () => {
  const r = await raceRig({ origin: 'https://www.example-motors.test', vin: 'aaa', kind: 'price', price: WANT_PRICE, listingUrl: LISTED_PAGE.url, name: 'Car A', listedPrice: 20000 });
  try {
    r.holdRead = true;
    await r.tick(); // a poll starts and waits on the listing read
    assert.ok(r.heldRead, 'the read is in flight');
    const done = handleUpkeepClick('upkeepDoneBtn', r.ctx);
    await r.untilLookups(1); // finish asks whether another item follows
    r.tabGone = true;
    r.heldRead.fail(new Error('No tab with id: 9'));
    await r.flush();
    r.lookups[0](RACE_NEXT);
    await done;
    assert.equal(up.status, 'gone', 'the late poll moved the item on while the lookup ran');
    assert.equal(up.hasNext, false, 'so no Open next To do item is recorded for a view that is no longer done');
  } finally {
    await endRaceRig(r);
  }
});

test('a read still in flight when Open next To do item is clicked answers after the tab has closed, during the lookup: no next item starts over it', async () => {
  const r = await raceRig({ origin: 'https://www.example-motors.test', vin: 'aaa', kind: 'takeDown', why: 'gone', name: 'Car A', listingUrl: LISTED_PAGE.url, listedPrice: 20000 });
  const drawn = []; // the panel each render draws, in order
  r.ctx.render = () => { drawn.push(upkeepHtml()); };
  try {
    r.holdRead = true;
    await r.tick(); // a poll starts and waits on the listing read
    const done = handleUpkeepClick('upkeepDoneBtn', r.ctx);
    await r.untilLookups(1);
    r.lookups[0](RACE_NEXT); // another item follows
    await done;
    assert.equal(up.hasNext, true);
    assert.match(drawn.at(-1), /id="upkeepNext"/, 'and the last panel drawn offers it');
    handleUpkeepClick('upkeepNext', r.ctx);
    await r.untilLookups(2);
    r.tabGone = true;
    r.heldRead.fail(new Error('No tab with id: 9'));
    await r.flush();
    r.lookups[1](RACE_NEXT); // the answer comes back after the late poll has written the status
    await r.flush();
    assert.equal(up.status, 'gone', 'the late poll moved the item on while the next item was looked up');
    assert.equal(up.vin, 'AAA', 'and the next item did not start');
    // the same read answering with the tab still open, on a page that now shows the car sold, finishes nothing over
    // the lookup: the panel keeps the Finding line
    r.tabGone = false;
    const third = startUpkeep({ origin: 'https://www.example-motors.test', vin: 'ccc', kind: 'takeDown', why: 'gone', name: 'Car C', listingUrl: LISTED_PAGE.url, listedPrice: 20000 }, r.ctx);
    await r.flush();
    await r.tick(); // the wait before the first poll ends
    await third;
    await r.tick(); // the first read: the listing as it opened, not sold
    r.holdRead = true;
    await r.tick(); // the next read waits on the page
    const doneC = handleUpkeepClick('upkeepDoneBtn', r.ctx);
    await r.untilLookups(3);
    r.lookups[2](RACE_NEXT); // another item follows
    await doneC;
    handleUpkeepClick('upkeepNext', r.ctx);
    await r.untilLookups(4);
    r.heldRead.answer([{ result: { ...LISTED_PAGE, sold: true } }]); // the person has marked it sold meanwhile
    await r.flush();
    assert.match(upkeepHtml(), /<p class="hint" id="upkeepFinding">Finding the next To do item…<\/p>/, 'a take-down read answering during the lookup leaves the Finding line drawn');
    // a take-down with no saved link reads the posted list after the page, and that read answering during the lookup
    // sets nothing either: the done banner an empty lookup brings back keeps its note
    r.lookups[3](null);
    await r.flush();
    const fourth = startUpkeep({ origin: 'https://www.example-motors.test', vin: 'ddd', kind: 'takeDown', why: 'gone', name: 'Car D', listingUrl: '', listedPrice: 20000 }, r.ctx);
    await r.flush();
    await r.tick(); // the wait before the first poll ends
    await fourth;
    r.holdRead = true;
    await r.tick(); // the poll's read waits on the page
    const get = chrome.storage.local.get;
    let answerList = null;
    chrome.storage.local.get = (keys) => (Array.isArray(keys) ? new Promise((resolve) => { answerList = () => get(keys).then(resolve); }) : get(keys));
    r.heldRead.answer([{ result: { ...LISTED_PAGE, url: FORM_MAP.yourListingsUrl, matchesId: false } }]); // the tab is on Your listings
    await r.flush();
    assert.equal(typeof answerList, 'function', 'the posted list is being read');
    const doneD = handleUpkeepClick('upkeepDoneBtn', r.ctx);
    await r.untilLookups(5);
    r.lookups[4](RACE_NEXT); // another item follows
    await doneD;
    const lookupD = handleUpkeepClick('upkeepNext', r.ctx);
    await r.untilLookups(6);
    answerList();
    await r.flush();
    r.lookups[5](null); // no next item after all
    assert.equal(await lookupD, true);
    assert.match(upkeepHtml(), /<div class="banner good" id="upkeepDone">Done\. Marked done\.<\/div>/, 'a take-down\'s posted list answering during the lookup leaves the done banner its note');
  } finally {
    await endRaceRig(r);
  }
});

// A take-down with no saved link reads the posted list only while its item is open: its listing read answering after the
// item is done reads nothing from the posted list, and changes nothing on the panel.
test('a take-down finished while its listing read is in flight reads nothing from the posted list when that read answers', async () => {
  const r = await raceRig({ origin: 'https://www.example-motors.test', vin: 'aaa', kind: 'takeDown', why: 'gone', name: 'Car A', listingUrl: '', listedPrice: 20000 });
  try {
    r.holdRead = true;
    await r.tick(); // a poll starts and waits on the listing read
    assert.ok(r.heldRead, 'the listing read is in flight');
    const done = handleUpkeepClick('upkeepDoneBtn', r.ctx);
    await r.untilLookups(1);
    r.lookups[0](null); // no next item
    assert.equal(await done, true);
    assert.equal(up.status, 'done');
    const get = chrome.storage.local.get;
    const posted = siteKeys('https://www.example-motors.test').posted;
    const postedReads = []; // the reads of the posted list and the take-down record that the poll's name check makes
    chrome.storage.local.get = (keys) => {
      if (Array.isArray(keys) && keys.includes(posted)) postedReads.push(keys);
      return get(keys);
    };
    r.heldRead.answer([{ result: { ...LISTED_PAGE } }]); // the listing as it opened, answering after the item is done
    await r.flush();
    chrome.storage.local.get = get;
    assert.deepEqual(postedReads, [], 'the done item reads nothing from the posted list');
    assert.equal(up.status, 'done', 'and the late answer changes nothing on the done item');
    assert.match(upkeepHtml(), /<div class="banner good" id="upkeepDone">Done\. Marked done\.<\/div>/);
  } finally {
    await endRaceRig(r);
  }
});

// The listing tab closed while the item waits, before Lot Current saw the change: the panel asks whether the person
// finished, and I updated it or Not now answers. The race tests above reach gone only after the item was recorded.
test('a listing tab closed while the item waits asks whether the person finished, with I updated it and Not now', async () => {
  const r = await raceRig({ origin: 'https://www.example-motors.test', vin: 'aaa', kind: 'price', price: WANT_PRICE, listingUrl: LISTED_PAGE.url, name: 'Car A', listedPrice: 20000 });
  try {
    r.holdRead = true;
    await r.tick(); // a poll starts and waits on the listing read
    r.tabGone = true; // the person closes the listing tab
    r.heldRead.fail(new Error('No tab with id: 9'));
    await r.flush();
    assert.equal(up.status, 'gone');
    assert.match(upkeepHtml(), /<div class="banner warn">The listing tab was closed\. Did you finish\?<\/div>\s*<div class="actions"><button type="button" class="primary" id="upkeepDoneBtn">I updated it<\/button><button type="button" class="plain" id="upkeepCancel">Not now<\/button><\/div>/);
  } finally {
    await endRaceRig(r);
  }
});

// A take-down Lot Current sees on the listing (the page says sold after its first read) is done by itself, and the done
// banner says what the page showed.
test('a take-down whose listing then shows it sold is done, and the done banner says the listing shows it as sold or removed', async () => {
  const r = await raceRig({ origin: 'https://www.example-motors.test', vin: 'aaa', kind: 'takeDown', why: 'gone', name: 'Car A', listingUrl: LISTED_PAGE.url, listedPrice: 20000 });
  r.ctx.nextItem = async () => null;
  try {
    await r.tick(); // the first read: the listing as it opened, not sold
    r.holdRead = true;
    await r.tick(); // the next read waits on the page
    r.heldRead.answer([{ result: { ...LISTED_PAGE, sold: true } }]); // the person has marked it sold
    await r.flush();
    assert.equal(up.status, 'done');
    assert.match(upkeepHtml(), /<div class="banner good" id="upkeepDone">Done\. The listing shows it as sold or removed\.<\/div>/);
  } finally {
    await endRaceRig(r);
  }
});

// the same take-down with another To do item after it: the last panel drawn offers Open next To do item
test('a take-down whose listing then shows it sold, with another To do item after it, leaves Open next To do item in the last panel drawn', async () => {
  const r = await raceRig({ origin: 'https://www.example-motors.test', vin: 'aaa', kind: 'takeDown', why: 'gone', name: 'Car A', listingUrl: LISTED_PAGE.url, listedPrice: 20000 });
  const drawn = []; // the panel each render draws, in order
  r.ctx.render = () => { drawn.push(upkeepHtml()); };
  r.ctx.nextItem = async () => RACE_NEXT;
  try {
    await r.tick(); // the first read: the listing as it opened, not sold
    r.holdRead = true;
    await r.tick(); // the next read waits on the page
    r.heldRead.answer([{ result: { ...LISTED_PAGE, sold: true } }]); // the person has marked it sold
    await r.flush();
    assert.equal(up.status, 'done');
    assert.match(drawn.at(-1), /<div class="banner good" id="upkeepDone">Done\. The listing shows it as sold or removed\.<\/div>[\s\S]*id="upkeepNext"/, 'and the last panel drawn offers Open next To do item');
  } finally {
    await endRaceRig(r);
  }
});

test('a read still in flight when another To do item starts answers after it has started: its answer is none of the new item\'s, so the new item keeps its own listing id and page', async () => {
  const origin = 'https://www.example-motors.test';
  const r = await raceRig({ origin, vin: 'aaa', kind: 'takeDown', why: 'gone', name: 'Car A', listingUrl: LISTED_PAGE.url, listedPrice: 20000 });
  try {
    r.holdRead = true;
    await r.tick(); // a poll starts and waits on the listing read
    assert.ok(r.heldRead, 'the read is in flight');
    // the next item saves no listing link, so its listing is found by its name and price
    const next = startUpkeep({ origin, vin: 'bbb', kind: 'takeDown', why: 'gone', name: 'Car B', listingUrl: '', listedPrice: 20000 }, r.ctx);
    await r.flush(); // the new item's tab is open and its wait begins
    await r.tick();
    await next;
    assert.equal(up.vin, 'BBB');
    r.heldRead.answer([{ result: { ...LISTED_PAGE } }]); // car A's read answers now, on car A's listing page
    await r.flush();
    assert.equal(up.listingId, '', 'car A\'s listing id is not saved for car B');
    assert.equal(up.baseline, null, 'nor is car A\'s page the baseline of car B');
  } finally {
    await endRaceRig(r);
  }
});

test('a next-item lookup that answers after its item was ended opens no listing, even while the item that replaced it is looking up its own next item', async () => {
  const opened = [];
  const lookups = [];
  globalThis.chrome = { tabs: { create: async ({ url }) => { opened.push(url); return { id: 34 }; } } };
  const ctx = { render: noop, map: () => FORM_MAP, nextItem: () => new Promise((resolve) => { lookups.push(resolve); }), onClose: noop };
  try {
    Object.assign(up, { ...DONE_CAR, hasNext: true });
    const first = handleUpkeepClick('upkeepNext', ctx); // car A's next item is looked up
    endUpkeep(); // Close, the one button drawn while the next item is looked up: that run has ended
    Object.assign(up, { ...DONE_CAR, active: true, vin: 'CCC', name: 'Car C', hasNext: true }); // car C is done, with one more item to find
    const second = handleUpkeepClick('upkeepNext', ctx);
    assert.equal(up.status, 'finding', 'car C\'s own lookup is under way');
    lookups[0](NEXT); // car A's lookup answers now
    assert.equal(await first, true);
    assert.deepEqual(opened, [], 'no listing opens over car C');
    assert.deepEqual([up.vin, up.status], ['CCC', 'finding'], 'car C is still the item shown, and still looking up');
    lookups[1](null);
    assert.equal(await second, true);
    assert.equal(up.status, 'done', 'car C\'s lookup found nothing: its done banner is back');
    // an ended item's lookup that finds nothing draws no done banner over the lookup that replaced it either
    Object.assign(up, { ...DONE_CAR, hasNext: true });
    const third = handleUpkeepClick('upkeepNext', ctx); // car A's next item is looked up again, and Close ends that run
    endUpkeep();
    Object.assign(up, { ...DONE_CAR, active: true, vin: 'CCC', name: 'Car C', hasNext: true });
    const fourth = handleUpkeepClick('upkeepNext', ctx);
    lookups[2](null); // car A's lookup answers now, with nothing
    assert.equal(await third, true);
    assert.deepEqual([up.vin, up.status], ['CCC', 'finding'], 'car C is still looking up: no done banner is drawn over its Finding line');
    lookups[3](null);
    assert.equal(await fourth, true);
    // nor does one that fails: a failure reads as no next item, and is dropped the same way
    Object.assign(up, { ...DONE_CAR, hasNext: true });
    const fifth = handleUpkeepClick('upkeepNext', ctx); // car A's next item is looked up again, and Close ends that run
    endUpkeep();
    Object.assign(up, { ...DONE_CAR, active: true, vin: 'CCC', name: 'Car C', hasNext: true });
    const sixth = handleUpkeepClick('upkeepNext', ctx);
    lookups[4](Promise.reject(new Error('storage is unavailable'))); // car A's lookup fails now
    assert.equal(await fifth, true);
    assert.deepEqual([up.vin, up.status], ['CCC', 'finding'], 'car C is still looking up: a failed lookup draws no done banner over its Finding line');
    lookups[5](null);
    assert.equal(await sixth, true);
  } finally {
    endUpkeep();
    delete globalThis.chrome;
  }
});

test('an item\'s next-item question answered after another item replaced it sets no Open next To do item on that item', async () => {
  const origin = 'https://www.example-motors.test';
  const k = siteKeys(origin);
  const store = { [k.posted]: { AAA: { price: 20000, postedAt: 1, mine: true, name: 'Car A' } } };
  let answer = null;
  globalThis.chrome = { ...fakeChrome({}, store), tabs: { create: async () => ({ id: 35 }) }, runtime: { sendMessage: async () => ({}) } };
  const ctx = { render: noop, map: () => FORM_MAP, nextItem: () => new Promise((resolve) => { answer = resolve; }), onClose: noop };
  try {
    Object.assign(up, { ...DONE_CAR, status: 'waiting', hasNext: false });
    const done = handleUpkeepClick('upkeepDoneBtn', ctx); // car A is finished: whether another item follows is asked
    for (let i = 0; i < 50 && !answer; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    // Close: the done banner's one button while car A's next item is looked up.
    endUpkeep(); // car C is shown next, done, with nothing after it
    Object.assign(up, { ...DONE_CAR, vin: 'CCC', name: 'Car C', hasNext: false });
    answer(NEXT); // car A's answer comes late: another item follows car A
    assert.equal(await done, true);
    assert.equal(up.vin, 'CCC');
    assert.equal(up.hasNext, false, 'the late answer offers no Open next To do item on car C');
  } finally {
    endUpkeep();
    delete globalThis.chrome;
  }
});

test('a read of the posted list still in flight when another To do item starts answers after it has started: the read is not the new item\'s, so the new item keeps its own listing id and page', async () => {
  const origin = 'https://www.example-motors.test';
  const r = await raceRig({ origin, vin: 'aaa', kind: 'takeDown', why: 'gone', name: 'Car A', listingUrl: '', listedPrice: 20000 });
  // car A has no saved link, so its listing is found by its name and price, which reads the posted list first; that read is held until the test answers it
  const get = chrome.storage.local.get;
  let answerList = null;
  chrome.storage.local.get = (keys) => new Promise((resolve) => { answerList = () => get(keys).then(resolve); });
  try {
    r.holdRead = true;
    await r.tick(); // a poll starts and waits on the listing read
    r.heldRead.answer([{ result: { ...LISTED_PAGE } }]); // car A's listing page answers: the posted list is read next
    await r.flush();
    assert.ok(answerList, 'the posted list is being read');
    // another item starts while that read is in flight; the next item saves no listing link
    const next = startUpkeep({ origin, vin: 'bbb', kind: 'takeDown', why: 'gone', name: 'Car B', listingUrl: '', listedPrice: 20000 }, r.ctx);
    await r.flush(); // the new item's tab is open and its wait begins
    await r.tick();
    await next;
    answerList(); // the posted list answers now, after car B has started
    await r.flush();
    assert.equal(up.vin, 'BBB');
    assert.equal(up.listingId, '', 'car A\'s listing id is not saved for car B');
    assert.equal(up.baseline, null, 'nor is car A\'s page the baseline of car B');
  } finally {
    await endRaceRig(r);
  }
});

// A second finish of the same item (I updated it again, after the tab has closed and the item reads as gone) asks the
// next-item question again. The panel keeps the button only on the answer the latest finish gets.
test('a second finish of an item whose next-item answer is no leaves no Open next To do item on the panel', async () => {
  const r = await raceRig({ origin: 'https://www.example-motors.test', vin: 'aaa', kind: 'price', price: WANT_PRICE, listingUrl: LISTED_PAGE.url, name: 'Car A', listedPrice: 20000 });
  try {
    r.holdRead = true;
    await r.tick(); // a poll starts and waits on the listing read
    assert.ok(r.heldRead, 'the read is in flight');
    const first = handleUpkeepClick('upkeepDoneBtn', r.ctx); // I updated it: another To do item follows
    await r.untilLookups(1);
    r.lookups[0](RACE_NEXT);
    assert.equal(await first, true);
    await r.flush();
    assert.equal(up.hasNext, true);
    assert.match(r.drawn.at(-1), /id="upkeepNext"/, 'the button is drawn with the first answer');
    r.tabGone = true; // the read in flight answers after the tab has closed: the item reads as gone
    r.heldRead.fail(new Error('No tab with id: 9'));
    await r.flush();
    assert.equal(up.status, 'gone');
    const second = handleUpkeepClick('upkeepDoneBtn', r.ctx); // I updated it again
    await r.untilLookups(2);
    assert.doesNotMatch(r.drawn.at(-1), /id="upkeepNext"/, 'while the question waits, the panel offers no button');
    r.lookups[1](null); // this time no other item follows
    assert.equal(await second, true);
    await r.flush();
    assert.deepEqual([up.status, up.hasNext], ['done', false]);
    assert.doesNotMatch(r.drawn.at(-1), /id="upkeepNext"/, 'the panel drawn last offers no button');
    // the click is not awaited before the check: a click that asks a question nobody answers would hang the test instead of failing it
    const click = handleUpkeepClick('upkeepNext', r.ctx);
    await r.flush();
    assert.deepEqual([up.status, r.lookups.length], ['done', 2], 'and a click on no button asks no next-item question');
    assert.equal(await click, true);
  } finally {
    await endRaceRig(r);
  }
});

// Two finishes of one item, each waiting on its own question: the answers come back in the other order, and the
// earlier finish's answer, which came last, is not written on the panel.
test('two finishes of one item whose answers come back out of order leave the later finish\'s answer on the panel', async () => {
  const r = await raceRig({ origin: 'https://www.example-motors.test', vin: 'aaa', kind: 'price', price: WANT_PRICE, listingUrl: LISTED_PAGE.url, name: 'Car A', listedPrice: 20000 });
  try {
    r.holdRead = true;
    await r.tick();
    assert.ok(r.heldRead, 'the read is in flight');
    const first = handleUpkeepClick('upkeepDoneBtn', r.ctx); // I updated it: its question waits
    await r.untilLookups(1);
    r.tabGone = true;
    r.heldRead.fail(new Error('No tab with id: 9'));
    await r.flush();
    assert.equal(up.status, 'gone');
    const second = handleUpkeepClick('upkeepDoneBtn', r.ctx); // I updated it again, while the first question still waits
    await r.untilLookups(2);
    r.lookups[1](null); // the later question answers first: no other item follows
    assert.equal(await second, true);
    r.lookups[0](RACE_NEXT); // the earlier question answers last, with another item
    assert.equal(await first, true);
    await r.flush();
    assert.deepEqual([up.status, up.hasNext], ['done', false], 'the later answer stands');
    assert.doesNotMatch(r.drawn.at(-1), /id="upkeepNext"/, 'the panel drawn last offers no button');
  } finally {
    await endRaceRig(r);
  }
});

// Open next To do item clicked while a second finish is still writing: that finish must not put the panel back to done
// over the lookup the click started, or the click is lost and the button is drawn again.
test('an Open next To do item clicked while a second finish still writes opens the item it finds, and that finish leaves the panel alone', async () => {
  const origin = 'https://www.example-motors.test';
  const diff = siteKeys(origin).diff;
  const r = await raceRig({ origin, vin: 'aaa', kind: 'price', price: WANT_PRICE, listingUrl: LISTED_PAGE.url, name: 'Car A', listedPrice: 20000 });
  // the second finish's write waits until the test releases it: the lock on the record runs the first finish's write first,
  // so the first finish finishes and asks while the second one is still writing
  const get = chrome.storage.local.get;
  let reads = 0;
  let releaseSecond = null;
  chrome.storage.local.get = (keys) => {
    if (![keys].flat().includes(diff)) return get(keys);
    reads += 1;
    if (reads === 1) return get(keys);
    return new Promise((resolve) => { releaseSecond = () => get(keys).then(resolve); });
  };
  try {
    const first = handleUpkeepClick('upkeepDoneBtn', r.ctx); // I updated it
    const second = handleUpkeepClick('upkeepDoneBtn', r.ctx); // I updated it again, before the first has finished
    await r.untilLookups(1); // the first finish has written and asks whether another To do item follows
    r.lookups[0](RACE_NEXT);
    await r.flush();
    assert.deepEqual([up.status, up.hasNext], ['done', true]);
    assert.match(r.drawn.at(-1), /id="upkeepNext"/, 'the button is drawn with the first answer');
    assert.equal(typeof releaseSecond, 'function', 'the second finish is still writing');
    const opened = handleUpkeepClick('upkeepNext', r.ctx); // Open next To do item: the next item is looked up
    await r.untilLookups(2);
    await r.flush();
    assert.equal(up.status, 'finding', 'the panel shows the lookup while the second finish still writes');
    releaseSecond(); // the second finish's write ends now, during the lookup
    await r.flush();
    assert.equal(up.status, 'finding', 'the second finish does not put the panel back to done over the lookup');
    assert.equal(r.lookups.length, 2, 'and asks no next-item question of its own');
    r.lookups[1](RACE_NEXT); // the lookup finds car B, which opens
    await r.flush();
    await r.tick(); // car B's tab is open, and its wait ends
    assert.equal(await opened, true);
    assert.deepEqual([up.vin, up.status], ['BBB', 'waiting'], 'the click opened the item it found');
    assert.equal(await first, true);
    assert.equal(await second, true);
  } finally {
    if (releaseSecond) releaseSecond(); // a write left held would keep the record's lock for the tests after this one
    await endRaceRig(r);
  }
});

// The first finish saved the record, so a repeat finish whose own write then fails draws no error: the done panel stays, and
// nothing on it says that the storage is full.
test('a repeat finish whose write fails draws no error on the done panel, since the first finish saved the record', async () => {
  const origin = 'https://www.example-motors.test';
  const k = siteKeys(origin);
  const r = await raceRig({ origin, vin: 'aaa', kind: 'price', price: WANT_PRICE, listingUrl: LISTED_PAGE.url, name: 'Car A', listedPrice: 20000 }, {
    [k.diff]: { priceUpdates: [{ vin: 'AAA', name: 'Car A', yours: true }] },
  });
  // the repeat finish's diff write is the second one: it waits until the test fails it, as Chrome does when the storage is full
  const set = chrome.storage.local.set;
  let diffWrites = 0;
  let refuseRepeat = null;
  chrome.storage.local.set = (obj) => {
    if (!(k.diff in obj)) return set(obj);
    diffWrites += 1;
    if (diffWrites === 1) return set(obj);
    return new Promise((resolve, reject) => { refuseRepeat = reject; });
  };
  try {
    const first = handleUpkeepClick('upkeepDoneBtn', r.ctx); // I updated it
    const repeat = handleUpkeepClick('upkeepDoneBtn', r.ctx); // I updated it again, before the first has finished
    await r.untilLookups(1);
    await r.flush();
    assert.equal(up.status, 'done', 'the first finish is done while the repeat is still writing');
    assert.equal(typeof refuseRepeat, 'function', 'the repeat finish reached its diff write');
    refuseRepeat(new Error('QUOTA_BYTES quota exceeded'));
    assert.equal(await repeat, true);
    assert.equal(up.error, '', 'the repeat draws no error, since the first finish saved the record');
    assert.doesNotMatch(upkeepHtml(), /banner bad/);
    assert.match(upkeepHtml(), /<div class="banner good" id="upkeepDone">Done\. Marked done\.<\/div>/);
    r.lookups[0](null); // no next item
    assert.equal(await first, true);
  } finally {
    chrome.storage.local.set = set;
    if (refuseRepeat) refuseRepeat(new Error('released')); // a write left held would keep the record's lock for the tests after this one
    await endRaceRig(r);
  }
});

// The repeat finish's write fails while Open next To do item looks up the next item: the Finding line is drawn, and the repeat's
// failed write draws no error over it.
test('a repeat finish whose write fails while Open next To do item looks up the next item draws no error over the Finding line', async () => {
  const origin = 'https://www.example-motors.test';
  const k = siteKeys(origin);
  const r = await raceRig({ origin, vin: 'aaa', kind: 'price', price: WANT_PRICE, listingUrl: LISTED_PAGE.url, name: 'Car A', listedPrice: 20000 }, {
    [k.diff]: { priceUpdates: [{ vin: 'AAA', name: 'Car A', yours: true }] },
  });
  const set = chrome.storage.local.set;
  let diffWrites = 0;
  let refuseRepeat = null;
  chrome.storage.local.set = (obj) => {
    if (!(k.diff in obj)) return set(obj);
    diffWrites += 1;
    if (diffWrites === 1) return set(obj);
    return new Promise((resolve, reject) => { refuseRepeat = reject; });
  };
  try {
    const first = handleUpkeepClick('upkeepDoneBtn', r.ctx); // I updated it
    const repeat = handleUpkeepClick('upkeepDoneBtn', r.ctx); // I updated it again, before the first has finished
    await r.untilLookups(1);
    await r.flush();
    r.lookups[0](RACE_NEXT); // the first finish: another item follows, so its button is drawn
    assert.equal(await first, true);
    assert.deepEqual([up.status, up.hasNext], ['done', true]);
    const next = handleUpkeepClick('upkeepNext', r.ctx); // Open next To do item, while the repeat's write still waits
    await r.untilLookups(2);
    assert.equal(up.status, 'finding');
    assert.equal(typeof refuseRepeat, 'function', 'the repeat finish reached its diff write');
    refuseRepeat(new Error('QUOTA_BYTES quota exceeded'));
    assert.equal(await repeat, true);
    assert.equal(up.error, '', 'the repeat draws no error over the Finding line');
    assert.doesNotMatch(upkeepHtml(), /banner bad/);
    assert.match(upkeepHtml(), /id="upkeepFinding"/);
    r.lookups[1](null); // the next item's lookup finds nothing
    assert.equal(await next, true);
    assert.equal(up.status, 'done');
  } finally {
    chrome.storage.local.set = set;
    if (refuseRepeat) refuseRepeat(new Error('released')); // a write left held would keep the record's lock for the tests after this one
    await endRaceRig(r);
  }
});

// The repeat finish's write fails after the first finish has saved the record, while the first finish reads the account and the
// item is not done yet. The error is drawn meanwhile, since the item is still open, but the done panel carries none.
test('a repeat finish whose write fails while the first finish reads the account leaves no error on the done panel', async () => {
  const origin = 'https://www.example-motors.test';
  const k = siteKeys(origin);
  const r = await raceRig({ origin, vin: 'aaa', kind: 'price', price: WANT_PRICE, listingUrl: LISTED_PAGE.url, name: 'Car A', listedPrice: 20000 }, {
    [k.diff]: { priceUpdates: [{ vin: 'AAA', name: 'Car A', yours: true }] },
  });
  // the first finish's account read, which comes after its writes, waits until the test answers it
  const get = chrome.storage.local.get;
  let holding = false;
  let releaseAccount = null;
  chrome.storage.local.get = (keys) => {
    if (!holding || ![keys].flat().includes(GLOBAL_KEYS.account)) return get(keys);
    holding = false;
    return new Promise((resolve) => { releaseAccount = () => get(keys).then(resolve); });
  };
  // the repeat finish's diff write is the second one: it waits until the test fails it, as Chrome does when the storage is full
  const set = chrome.storage.local.set;
  let diffWrites = 0;
  let refuseRepeat = null;
  chrome.storage.local.set = (obj) => {
    if (!(k.diff in obj)) return set(obj);
    diffWrites += 1;
    if (diffWrites === 1) return set(obj);
    return new Promise((resolve, reject) => { refuseRepeat = reject; });
  };
  try {
    holding = true;
    const first = handleUpkeepClick('upkeepDoneBtn', r.ctx); // I updated it
    await r.flush();
    assert.equal(typeof releaseAccount, 'function', 'the first finish is reading the account, after its writes');
    const repeat = handleUpkeepClick('upkeepDoneBtn', r.ctx); // I updated it again while the first one reads the account
    await r.flush();
    assert.equal(typeof refuseRepeat, 'function', 'the repeat finish reached its diff write');
    refuseRepeat(new Error('QUOTA_BYTES quota exceeded'));
    assert.equal(await repeat, true);
    assert.notEqual(up.status, 'done', 'the first finish is not done yet');
    assert.notEqual(up.error, '', 'the repeat\'s error is drawn while the item is still open');
    releaseAccount();
    await r.untilLookups(1);
    assert.equal(up.status, 'done');
    assert.equal(up.error, '', 'the done panel carries no error: the first finish saved the record');
    assert.doesNotMatch(upkeepHtml(), /banner bad/);
    assert.match(upkeepHtml(), /<div class="banner good" id="upkeepDone">Done\. Marked done\.<\/div>/);
    r.lookups[0](null); // no next item
    assert.equal(await first, true);
  } finally {
    chrome.storage.local.get = get;
    chrome.storage.local.set = set;
    if (releaseAccount) releaseAccount(); // a read left held would keep the first finish waiting for the tests after this one
    if (refuseRepeat) refuseRepeat(new Error('released'));
    await endRaceRig(r);
  }
});

// A second finish whose writes end after the first has drawn Open next To do item is not held back by that done: it asks
// its own question, and its answer is what the panel keeps.
test('a second finish whose writes end after the first finish drew Open next To do item draws its own answer on the panel', async () => {
  const origin = 'https://www.example-motors.test';
  const diff = siteKeys(origin).diff;
  const r = await raceRig({ origin, vin: 'aaa', kind: 'price', price: WANT_PRICE, listingUrl: LISTED_PAGE.url, name: 'Car A', listedPrice: 20000 });
  // the second finish's last write waits until the test releases it, as in the test above
  const get = chrome.storage.local.get;
  let reads = 0;
  let releaseSecond = null;
  chrome.storage.local.get = (keys) => {
    if (![keys].flat().includes(diff)) return get(keys);
    reads += 1;
    if (reads === 1) return get(keys);
    return new Promise((resolve) => { releaseSecond = () => get(keys).then(resolve); });
  };
  try {
    const first = handleUpkeepClick('upkeepDoneBtn', r.ctx); // I updated it
    const second = handleUpkeepClick('upkeepDoneBtn', r.ctx); // I updated it again, before the first has finished
    await r.untilLookups(1);
    assert.equal(typeof releaseSecond, 'function', 'the second finish is still writing');
    r.lookups[0](RACE_NEXT); // the first finish: another item follows, and its button is drawn
    assert.equal(await first, true);
    assert.deepEqual([up.status, up.hasNext], ['done', true]);
    assert.match(r.drawn.at(-1), /id="upkeepNext"/, 'the button is drawn with the first answer');
    releaseSecond(); // the second finish's write ends now, after the button is drawn
    await r.untilLookups(2);
    assert.equal(r.lookups.length, 2, 'the second finish asks its own question');
    assert.doesNotMatch(r.drawn.at(-1), /id="upkeepNext"/, 'while it waits, the panel offers no button');
    r.lookups[1](null); // no other item follows
    assert.equal(await second, true);
    await r.flush();
    assert.deepEqual([up.status, up.hasNext], ['done', false]);
    assert.doesNotMatch(r.drawn.at(-1), /id="upkeepNext"/, 'the panel drawn last offers no button');
  } finally {
    if (releaseSecond) releaseSecond();
    await endRaceRig(r);
  }
});

// A signed-in session, made as test/syncAfterChange.test.js makes one: finish asks the worker for a sync only then.
const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const signedIn = () => sessionFromTokenResponse({
  access_token: `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`,
  token_type: 'bearer', expires_in: 3600, refresh_token: 'refresh-1', user: { id: 'u1', email: 'alex@example.test' },
}, Date.now());

// finish writes to the website its item was started on. A To do item from another website that starts while car A's posted
// list is read takes the panel, but car A's pilot flag is closed on car A's website, and car B's flag stays open on its own,
// and the sync is asked for car A's website.
test('a take-down finished while a To do item from another website starts closes the flag on its own website and syncs that website', async () => {
  const origin = 'https://www.example-motors.test';
  const other = 'https://www.second-motors.test';
  const k = siteKeys(origin);
  const kOther = siteKeys(other);
  const flagged = { kind: 'takeDown', flaggedAt: '2026-10-02T09:00:00.000Z' };
  const store = {
    [GLOBAL_KEYS.account]: signedIn(),
    [k.posted]: { AAA: { price: 20000, postedAt: 1, mine: true, name: 'Car A' } },
    [k.diff]: { takeDown: [{ vin: 'AAA' }] },
    [k.pilot]: { flags: [{ vin: 'AAA', name: 'Car A', ...flagged }] },
    [kOther.pilot]: { flags: [{ vin: 'BBB', name: 'Car B', ...flagged }] },
  };
  const r = await raceRig({ origin, vin: 'aaa', kind: 'takeDown', why: 'gone', name: 'Car A', listingUrl: at('111'), listedPrice: 20000 }, store);
  r.ctx.nextItem = async () => null; // car A's next-item question is not what this test is about
  // the first read of car A's posted list that finish makes is held until the test answers it
  const get = chrome.storage.local.get;
  let holding = true;
  let answerList = null;
  chrome.storage.local.get = (keys) => {
    if (!holding || ![keys].flat().includes(k.posted)) return get(keys);
    holding = false;
    return new Promise((resolve) => { answerList = () => get(keys).then(resolve); });
  };
  try {
    const done = handleUpkeepClick('upkeepDoneBtn', r.ctx); // car A: I took it down
    await r.flush();
    assert.ok(answerList, 'finish is reading the posted list');
    // a To do item from the other website starts meanwhile, and takes the panel
    endUpkeep();
    const next = startUpkeep({ origin: other, vin: 'bbb', kind: 'takeDown', why: 'gone', name: 'Car B', listingUrl: at('222'), listedPrice: 21000 }, r.ctx);
    await r.flush();
    await r.tick();
    await next;
    assert.equal(up.origin, other);
    answerList(); // car A's read answers now, and finish goes on
    assert.equal(await done, true);
    await r.flush();
    const flag = (key, vin) => store[key].flags.find((f) => f.vin === vin);
    assert.deepEqual([flag(k.pilot, 'AAA').how, typeof flag(k.pilot, 'AAA').doneAt], ['manual', 'string'], 'car A\'s flag, on its own website, is closed by the person');
    assert.equal(flag(kOther.pilot, 'BBB').doneAt, undefined, 'car B\'s flag, on the other website, stays open');
    assert.deepEqual(r.messages.filter((m) => m.type === 'syncNow'), [{ type: 'syncNow', origin }], 'the sync is asked for car A\'s website');
  } finally {
    await endRaceRig(r);
  }
});

// finish (upkeep.js) reads the car's fields and run before its first await:
// car A's record is written even when the panel has moved on to car B, and car
// B's state, note, next-item button and list entries are left as they were.
test('a take-down finished while its posted-list read waits writes only its own car, when another To do item starts meanwhile', async () => {
  const origin = 'https://www.example-motors.test';
  const k = siteKeys(origin);
  const store = {
    [k.posted]: { AAA: { price: 20000, postedAt: 1, mine: true, name: 'Car A' }, BBB: { price: 21000, postedAt: 1, mine: true, name: 'Car B' } },
    [k.diff]: { takeDown: [{ vin: 'AAA' }, { vin: 'BBB' }] },
    [k.pilot]: { flags: [{ vin: 'AAA', kind: 'takeDown', name: 'Car A', flaggedAt: '2026-10-02T09:00:00.000Z' }, { vin: 'BBB', kind: 'takeDown', name: 'Car B', flaggedAt: '2026-10-02T09:00:00.000Z' }] },
  };
  const r = await raceRig({ origin, vin: 'aaa', kind: 'takeDown', why: 'gone', name: 'Car A', listingUrl: at('111'), listedPrice: 20000 }, store);
  r.ctx.nextItem = async () => null; // car A's next-item question is not what this test is about
  // the first read of the posted list that finish makes is held until the test answers it
  const get = chrome.storage.local.get;
  let holding = false;
  let answerList = null;
  chrome.storage.local.get = (keys) => {
    if (!holding || ![keys].flat().includes(k.posted)) return get(keys);
    holding = false;
    return new Promise((resolve) => { answerList = () => get(keys).then(resolve); });
  };
  try {
    holding = true;
    const done = handleUpkeepClick('upkeepDoneBtn', r.ctx); // car A: I took it down
    await r.flush();
    assert.ok(answerList, 'finish is reading the posted list');
    // the person clicks car B's To do button: car A's item ends, and car B starts
    endUpkeep();
    const next = startUpkeep({ origin, vin: 'bbb', kind: 'takeDown', why: 'gone', name: 'Car B', listingUrl: at('222'), listedPrice: 21000 }, r.ctx);
    await r.flush();
    await r.tick();
    await next;
    assert.deepEqual([up.vin, up.status, up.note], ['BBB', 'waiting', '']);
    answerList(); // car A's read answers now, and finish goes on
    assert.equal(await done, true);
    await r.flush();
    // car B keeps its own state: no done banner, no note, no Open next To do item
    assert.deepEqual([up.vin, up.status, up.note, up.hasNext, up.error], ['BBB', 'waiting', '', false, '']);
    assert.match(upkeepHtml(), /id="takeDownWaiting"/);
    assert.doesNotMatch(upkeepHtml(), /id="upkeepDone"|id="upkeepNext"/);
    // car A's record is written (off the posted list, in the take-down record, out of the diff); car B's entries stay
    assert.equal(store[k.posted].AAA, undefined, 'car A is off the posted list');
    assert.ok(store[k.posted].BBB, 'car B is still on the posted list');
    assert.deepEqual(takenDownList(store[k.takenDown]).map((t) => t.vin), ['AAA'], 'car A\'s take-down is recorded');
    // the to-do flags (src/pilot.js resolveFlag): car A's is closed as ticked off by the person, car B's stays open
    const flag = (vin) => store[k.pilot].flags.find((f) => f.vin === vin);
    assert.deepEqual([flag('AAA').how, typeof flag('AAA').doneAt], ['manual', 'string'], 'car A\'s flag is closed by the person, with its time');
    assert.equal(flag('BBB').doneAt, undefined, 'car B\'s flag stays open');
    assert.deepEqual(store[k.diff].takeDown.map((x) => x.vin), ['BBB'], 'car B\'s take-down stays in the diff');
  } finally {
    await endRaceRig(r);
  }
});

// finish reads the car's fields before its first await: a price update writes the price and basis it was updated to,
// not those of the To do item the panel has moved to while the posted list is read.
test('a price update that finishes while another To do item starts saves its own price and basis', async () => {
  const origin = 'https://www.example-motors.test';
  const k = siteKeys(origin);
  const store = {
    [k.posted]: {
      AAA: { price: 20000, postedAt: 1, mine: true, name: 'Car A' },
      BBB: { price: 31000, postedAt: 1, mine: true, name: 'Car B' },
    },
    [k.diff]: { priceUpdates: [{ vin: 'AAA' }, { vin: 'BBB' }] },
    [k.pilot]: { flags: [{ vin: 'AAA', kind: 'price', name: 'Car A', flaggedAt: '2026-10-02T09:00:00.000Z' }, { vin: 'BBB', kind: 'price', name: 'Car B', flaggedAt: '2026-10-02T09:00:00.000Z' }] },
  };
  const r = await raceRig({
    origin, vin: 'aaa', kind: 'price', price: WANT_PRICE, listedPrice: 20000, name: 'Car A',
    listingUrl: LISTED_PAGE.url,
  }, store);
  // the first read of the posted list that finish makes is held until the test answers it
  const get = chrome.storage.local.get;
  let holding = true;
  let answerList = null;
  chrome.storage.local.get = (keys) => {
    if (!holding || ![keys].flat().includes(k.posted)) return get(keys);
    holding = false;
    return new Promise((resolve) => { answerList = () => get(keys).then(resolve); });
  };
  try {
    const done = handleUpkeepClick('upkeepDoneBtn', r.ctx); // car A: I updated it, at the price read on the website
    await r.flush();
    assert.ok(answerList, 'finish is reading the posted list');
    // the person clicks car B's To do button: car A's item ends, and car B starts at another price
    endUpkeep();
    r.ctx.priceNow = async () => ({ ok: true, price: 30000, basis: 'beforeFees' });
    const next = startUpkeep({
      origin, vin: 'bbb', kind: 'price', price: 30000, listingUrl: at('222'), name: 'Car B', listedPrice: 31000,
    }, r.ctx);
    await r.flush();
    await r.tick();
    await next;
    assert.deepEqual([up.vin, up.status, up.price, up.basis], ['BBB', 'waiting', 30000, 'beforeFees']);
    answerList(); // car A's read answers now, and finish writes car A's price and basis
    assert.equal(await done, true);
    await r.flush();
    const aaa = store[k.posted].AAA;
    assert.deepEqual([aaa.price, aaa.basis], [WANT_PRICE, 'website'], 'the price and basis car A was updated at');
    assert.equal(store[k.posted].BBB.price, 31000, 'car B is untouched');
    assert.deepEqual(store[k.diff].priceUpdates.map((x) => x.vin), ['BBB'], 'car B\'s price update stays in the diff');
    const flag = (vin) => store[k.pilot].flags.find((f) => f.vin === vin);
    assert.deepEqual([flag('AAA').how, typeof flag('AAA').doneAt], ['manual', 'string'], 'car A\'s price flag is closed by the person, with its time');
    assert.equal(flag('BBB').doneAt, undefined, 'car B\'s price flag stays open');
  } finally {
    await endRaceRig(r);
  }
});

test('a take-down finished while another To do item starts keeps its own car\'s name and post time', async () => {
  const origin = 'https://www.example-motors.test';
  const k = siteKeys(origin);
  const store = {
    [k.posted]: {
      AAA: { price: 20000, postedAt: '2026-10-01T10:00:00.000Z', mine: true, name: 'Car A' },
      BBB: { price: 21000, postedAt: '2026-10-20T10:00:00.000Z', mine: true, name: 'Car B', listedBefore: true },
    },
    [k.diff]: { takeDown: [{ vin: 'AAA' }, { vin: 'BBB' }] },
  };
  const r = await raceRig({
    origin, vin: 'aaa', kind: 'takeDown', why: 'gone', name: 'Car A', listingUrl: at('111'), listedPrice: 20000,
  }, store);
  // the posted-list read that finish makes for car A's take-down is held until the test answers it
  const get = chrome.storage.local.get;
  let holding = true;
  let answerList = null;
  chrome.storage.local.get = (keys) => {
    if (!holding || ![keys].flat().includes(k.posted)) return get(keys);
    holding = false;
    return new Promise((resolve) => { answerList = () => get(keys).then(resolve); });
  };
  try {
    const done = handleUpkeepClick('upkeepDoneBtn', r.ctx); // car A: I took it down
    await r.flush();
    assert.ok(answerList, 'finish is reading the posted list');
    endUpkeep();
    const next = startUpkeep({
      origin, vin: 'bbb', kind: 'takeDown', why: 'gone', name: 'Car B', listingUrl: at('222'), listedPrice: 21000,
    }, r.ctx);
    await r.flush();
    await r.tick();
    await next;
    assert.equal(up.vin, 'BBB');
    answerList(); // car A's read answers now, and finish records car A's take-down
    assert.equal(await done, true);
    await r.flush();
    // the take-down record names car A, with car A's post time and flag, not car B's
    const record = takenDownList(store[k.takenDown]).map((t) => [t.vin, t.name, t.postedAt, t.listedBefore === true]);
    assert.deepEqual(record, [['AAA', 'Car A', '2026-10-01T10:00:00.000Z', false]]);
  } finally {
    await endRaceRig(r);
  }
});

// finish draws a failed write's error, and clears the error on success, only while the panel still shows the car it was
// run for. The first step is the control: the car the panel shows draws its own failed write. Then the panel moves to
// car B, and car A's failed write is not drawn there.
test('a storage error on a finished car does not show on the car the panel moved to', async () => {
  const origin = 'https://www.example-motors.test';
  const k = siteKeys(origin);
  const store = {
    [k.posted]: {
      AAA: { price: 20000, postedAt: 1, mine: true, name: 'Car A' },
      BBB: { price: 21000, postedAt: 1, mine: true, name: 'Car B' },
    },
    [k.diff]: { takeDown: [{ vin: 'AAA' }, { vin: 'BBB' }] },
  };
  const r = await raceRig({
    origin, vin: 'aaa', kind: 'takeDown', why: 'gone', name: 'Car A', listingUrl: at('111'), listedPrice: 20000,
  }, store);
  const get = chrome.storage.local.get;
  let holding = false;
  let answerList = null;
  chrome.storage.local.get = (keys) => {
    if (!holding || ![keys].flat().includes(k.posted)) return get(keys);
    holding = false;
    return new Promise((resolve) => { answerList = () => get(keys).then(resolve); });
  };
  chrome.storage.local.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); }; // Chrome's storage is full
  try {
    // the control: car A is the car the panel shows, so its failed write is drawn there
    assert.equal(await handleUpkeepClick('upkeepDoneBtn', r.ctx), true); // car A: I took it down
    assert.equal(up.error, STORAGE_FULL);
    assert.match(upkeepHtml(), /class="banner bad">Couldn&#39;t save: Chrome&#39;s storage for Lot Current is full\./);
    holding = true;
    const done = handleUpkeepClick('upkeepDoneBtn', r.ctx); // car A again, while the posted list is read
    await r.flush();
    assert.ok(answerList, 'finish is reading the posted list');
    endUpkeep();
    const next = startUpkeep({
      origin, vin: 'bbb', kind: 'takeDown', why: 'gone', name: 'Car B', listingUrl: at('222'), listedPrice: 21000,
    }, r.ctx);
    await r.flush();
    await r.tick();
    await next;
    answerList(); // car A's write fails now, after car B has started
    assert.equal(await done, true);
    await r.flush();
    assert.deepEqual([up.vin, up.error], ['BBB', ''], 'car A\'s storage error is not drawn on car B');
    assert.doesNotMatch(upkeepHtml(), /banner bad/, 'and car B\'s panel shows no error');
  } finally {
    await endRaceRig(r);
  }
});

test('a finished car\'s success does not clear the error of the car the panel moved to', async () => {
  const origin = 'https://www.example-motors.test';
  const k = siteKeys(origin);
  const store = {
    [k.posted]: {
      AAA: { price: 20000, postedAt: 1, mine: true, name: 'Car A' },
      BBB: { price: 21000, postedAt: 1, mine: true, name: 'Car B' },
    },
    [k.diff]: { takeDown: [{ vin: 'AAA' }, { vin: 'BBB' }] },
  };
  const r = await raceRig({
    origin, vin: 'aaa', kind: 'takeDown', why: 'gone', name: 'Car A', listingUrl: at('111'), listedPrice: 20000,
  }, store);
  const get = chrome.storage.local.get;
  const create = chrome.tabs.create;
  let holding = true;
  let answerList = null;
  chrome.storage.local.get = (keys) => {
    if (!holding || ![keys].flat().includes(k.posted)) return get(keys);
    holding = false;
    return new Promise((resolve) => { answerList = () => get(keys).then(resolve); });
  };
  try {
    const done = handleUpkeepClick('upkeepDoneBtn', r.ctx); // car A: I took it down, and its write succeeds
    await r.flush();
    assert.ok(answerList, 'finish is reading the posted list');
    endUpkeep();
    chrome.tabs.create = async () => { throw new Error('no window to open it in'); }; // car B's listing tab cannot open
    await startUpkeep({
      origin, vin: 'bbb', kind: 'takeDown', why: 'gone', name: 'Car B', listingUrl: at('222'), listedPrice: 21000,
    }, r.ctx);
    assert.deepEqual([up.vin, up.status], ['BBB', 'open-failed']);
    answerList(); // car A's write succeeds now, and finish completes
    assert.equal(await done, true);
    await r.flush();
    assert.equal(store[k.posted].AAA, undefined, 'car A is off the posted list');
    assert.deepEqual([up.vin, up.status], ['BBB', 'open-failed']);
    assert.equal(up.error, 'Couldn\'t open the listing: no window to open it in', 'car B\'s error is kept');
    assert.match(upkeepHtml(), /Couldn&#39;t open the listing: no window to open it in/);
  } finally {
    chrome.tabs.create = create;
    await endRaceRig(r);
  }
});

// A listing read answering after another To do item started is none of that item's. With the new item saving no link,
// the answer would look the posted list up for the new item's name, so it must read nothing from storage.
test('a listing read still in flight when another To do item starts reads nothing from storage once it answers', async () => {
  const origin = 'https://www.example-motors.test';
  const r = await raceRig({ origin, vin: 'aaa', kind: 'takeDown', why: 'gone', name: 'Car A', listingUrl: at('111'), listedPrice: 20000 });
  const get = chrome.storage.local.get;
  const reads = [];
  chrome.storage.local.get = (keys) => { reads.push(keys); return get(keys); };
  try {
    r.holdRead = true;
    await r.tick(); // a poll starts and waits on the listing read
    assert.ok(r.heldRead, 'the read is in flight');
    const next = startUpkeep({ origin, vin: 'bbb', kind: 'takeDown', why: 'gone', name: 'Car B', listingUrl: '', listedPrice: 20000 }, r.ctx);
    await r.flush();
    await r.tick();
    await next;
    assert.equal(up.vin, 'BBB');
    reads.length = 0;
    r.heldRead.answer([{ result: { ...LISTED_PAGE } }]); // car A's read answers now
    await r.flush();
    assert.deepEqual(reads, [], 'and that answer reads nothing from storage');
  } finally {
    await endRaceRig(r);
  }
});

// The price fill (poll) is held while another To do item starts: the fill's result is none of the new item's, so the
// new item stays waiting, with nothing filled and no fill count.
test('a price fill still in flight when another To do item starts writes nothing on that item', async () => {
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const rig = await priceRig(LISTED_PAGE);
  const executeScript = chrome.scripting.executeScript;
  let answerFill = null;
  chrome.scripting.executeScript = (args) => (args.func === fillPriceInPage ? new Promise((resolve) => { answerFill = resolve; }) : executeScript(args));
  const ctx = { render: noop, map: () => FORM_MAP, priceNow: async () => ({ ok: true, price: 30000, basis: 'website' }), nextItem: async () => null, onClose: noop };
  try {
    await rig.tick(); // car A's first poll: its Price box shows the listed price, so the fill goes in and is held
    assert.ok(answerFill, 'car A\'s fill is in flight');
    const next = startUpkeep({ origin: 'https://www.example-motors.test', vin: 'bbb', kind: 'price', price: 30000, listingUrl: at('222'), name: 'Car B', listedPrice: 31000 }, ctx);
    await flush();
    mock.timers.tick(1500); // car B's wait ends
    await flush();
    await next;
    assert.deepEqual([up.vin, up.status, up.fills], ['BBB', 'waiting', 0]);
    answerFill([{ result: { ok: true, shown: '$18,500' } }]); // car A's fill answers now, with the price in the box
    await flush();
    assert.deepEqual([up.vin, up.status, up.filledShown, up.fills], ['BBB', 'waiting', '', 0], 'car A\'s fill result is not written on car B');
    assert.doesNotMatch(upkeepHtml(), /id="priceFilled"/, 'car B does not say its price is in the box');
  } finally {
    endRig();
    await rig.started;
  }
});

// The price fill answers after I updated the item: its result is not written on the finished item, which stays done with
// nothing filled, and the panel does not offer the fill's price as in the box.
test('a price fill still in flight when I updated it does not set the done item back to filled', async () => {
  const rig = await priceRig(LISTED_PAGE, { nextItem: async () => null });
  const executeScript = chrome.scripting.executeScript;
  let answerFill = null;
  chrome.scripting.executeScript = (args) => (args.func === fillPriceInPage ? new Promise((resolve) => { answerFill = resolve; }) : executeScript(args));
  try {
    await rig.tick(); // the Price box shows the listed price, so the fill goes in and is held
    assert.ok(answerFill, 'the fill is in flight');
    assert.equal(await handleUpkeepClick('upkeepDoneBtn', rig.ctx), true);
    assert.equal(up.status, 'done');
    answerFill([{ result: { ok: true, shown: '$18,500' } }]); // the fill answers now, with the price in the box
    await rig.flush();
    assert.equal(up.status, 'done', 'the late fill does not change the done item');
    assert.equal(up.filledShown, '', 'and no shown price is written on it');
    assert.doesNotMatch(upkeepHtml(), /id="priceFilled"/, 'the item is not drawn as filled');
    assert.match(upkeepHtml(), /id="upkeepDone"/, 'the done banner stays');
  } finally {
    endRig();
    await rig.started;
  }
});

// The same fill answering while the next To do item is looked for: the lookup is not dropped, and the item it finds opens.
test('a price fill still in flight while the next To do item is looked for does not drop the lookup: the item it finds opens', async () => {
  let answer = null;
  let lookupHeld = false;
  const rig = await priceRig(LISTED_PAGE, { nextItem: () => (lookupHeld ? new Promise((resolve) => { answer = resolve; }) : Promise.resolve(NEXT)) });
  const executeScript = chrome.scripting.executeScript;
  let answerFill = null;
  chrome.scripting.executeScript = (args) => (args.func === fillPriceInPage ? new Promise((resolve) => { answerFill = resolve; }) : executeScript(args));
  try {
    await rig.tick(); // the Price box shows the listed price, so the fill goes in and is held
    assert.ok(answerFill, 'the fill is in flight');
    assert.equal(await handleUpkeepClick('upkeepDoneBtn', rig.ctx), true);
    assert.equal(up.status, 'done');
    lookupHeld = true;
    // not awaited: the item the lookup opens waits on its own 1.5 s timer, which these fake timers run only on a tick
    handleUpkeepClick('upkeepNext', rig.ctx);
    assert.equal(up.status, 'finding', 'the next item is being looked for');
    answerFill([{ result: { ok: true, shown: '$18,500' } }]); // the fill answers while the lookup is held
    await rig.flush();
    assert.equal(up.status, 'finding', 'the late fill does not change the lookup');
    answer(NEXT);
    await rig.flush();
    assert.equal(up.vin, 'BBB', 'the item the lookup found opens');
  } finally {
    endRig();
    await rig.started;
  }
});

// A listing read still in flight when I updated the item fails after it: the tab is still open but moved off Marketplace,
// and the failure sets no note on the finished item, whose done banner is drawn as it was.
test('a listing read that fails after I updated it, with the tab moved off Marketplace, does not rewrite the done banner', async () => {
  const rig = await priceRig({ ...LISTED_PAGE, hasPriceBox: false }, { nextItem: async () => null });
  const executeScript = chrome.scripting.executeScript;
  let failRead = null;
  chrome.scripting.executeScript = (args) => (args.func === readListingInPage ? new Promise((resolve, reject) => { failRead = reject; }) : executeScript(args));
  rig.page = { ...rig.page, url: 'https://www.facebook.com/home' }; // the tab is still open, on a Facebook page that is not Marketplace
  try {
    await rig.tick(); // the poll's read goes out and is held in flight
    assert.ok(failRead, 'the read is in flight');
    assert.equal(await handleUpkeepClick('upkeepDoneBtn', rig.ctx), true);
    assert.equal(up.status, 'done');
    const drawn = upkeepHtml();
    failRead(new Error('the tab cannot be read')); // the read fails after I updated the item
    await rig.flush();
    assert.equal(up.status, 'done');
    assert.ok(!up.offTarget, 'the finished item is not marked as off its listing');
    assert.equal(upkeepHtml(), drawn, 'the done banner is drawn as it was');
  } finally {
    endRig();
    await rig.started;
  }
});

// A read that fails while the next To do item is looked for is about the item that is done: it writes nothing on it (over()
// covers finding as well as done), so the lookup's answer brings the done banner back as it was.
test('a listing read that fails while the next To do item is looked for, with the tab moved off Marketplace, leaves the done banner as it was', async () => {
  let lookups = 0;
  let answerLookup = null;
  // finish's question answers at once; the Open next To do item lookup after it is held until the test answers it
  const rig = await priceRig({ ...LISTED_PAGE, hasPriceBox: false }, {
    nextItem: () => {
      lookups += 1;
      return lookups === 1 ? Promise.resolve(NEXT) : new Promise((resolve) => { answerLookup = resolve; });
    },
  });
  const executeScript = chrome.scripting.executeScript;
  let failRead = null;
  chrome.scripting.executeScript = (args) => (args.func === readListingInPage ? new Promise((resolve, reject) => { failRead = reject; }) : executeScript(args));
  rig.page = { ...rig.page, url: 'https://www.facebook.com/home' }; // the tab is still open, on a Facebook page that is not Marketplace
  try {
    await rig.tick(); // the poll's read goes out and is held in flight
    assert.ok(failRead, 'the read is in flight');
    assert.equal(await handleUpkeepClick('upkeepDoneBtn', rig.ctx), true);
    assert.equal(up.hasNext, true, 'another item follows');
    const lookup = handleUpkeepClick('upkeepNext', rig.ctx); // the next item is looked for, and the lookup is held
    assert.equal(up.status, 'finding');
    failRead(new Error('the tab cannot be read')); // the read fails while the lookup runs
    await rig.flush();
    assert.deepEqual([up.status, up.note, up.offTarget], ['finding', 'Marked done.', false], 'the failed read writes nothing on the item while the lookup runs');
    answerLookup(null); // no next item after all
    assert.equal(await lookup, true);
    assert.deepEqual([up.status, up.hasNext, up.note, up.offTarget], ['done', false, 'Marked done.', false], 'the finished item keeps its note and is not marked off its listing');
    assert.match(rig.drawn.at(-1), /<div class="banner good" id="upkeepDone">Done\. Marked done\.<\/div>/, 'the done banner is drawn as it was');
  } finally {
    endRig();
    await rig.started;
  }
});

// A To do item taken down while its listing tab is still opening, or while the wait after the tab opened runs, is done for
// good: the tab's answer does not set it back to waiting, no poll starts on it, and a tab closed later does not replace
// its done banner. The take-down's own writes are held where a test needs them to be under way when the wait ends.
const TAKE_DOWN = { origin: 'https://www.example-motors.test', vin: 'aaa', kind: 'takeDown', why: 'gone', listingUrl: at('111'), name: 'Car A', listedPrice: 20000 };
const TAKE_DOWN_STORE = () => ({ [siteKeys(TAKE_DOWN.origin).posted]: { AAA: { name: 'Car A', price: 20000, postedAt: '2026-10-02T09:00:00.000Z', listingUrl: at('111') } } });
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve)); };

test('a take-down finished while its listing tab is still opening stays done when the tab answers, and no poll starts on it', async () => {
  let answerTab = null;
  const reads = [];
  globalThis.chrome = {
    ...fakeChrome({}, TAKE_DOWN_STORE()),
    tabs: { create: () => new Promise((resolve) => { answerTab = resolve; }), get: async (id) => ({ id, url: LISTED_PAGE.url }) },
    runtime: { sendMessage: async () => ({}) },
    scripting: { executeScript: async () => { reads.push(1); return [{ result: { ...LISTED_PAGE } }]; } },
  };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const ctx = { render: () => {}, map: () => FORM_MAP, nextItem: async () => null };
  const started = startUpkeep(TAKE_DOWN, ctx);
  try {
    await settle();
    assert.equal(up.status, 'opening', 'the listing tab is still being opened');
    assert.equal(await handleUpkeepClick('upkeepDoneBtn', ctx), true);
    assert.equal(up.status, 'done');
    answerTab({ id: 9 }); // the tab answers after I took the car down
    await settle();
    mock.timers.tick(1500);
    await started;
    assert.equal(up.status, 'done', 'the finished item is not set back to waiting');
    mock.timers.tick(1500);
    await settle();
    assert.equal(reads.length, 0, 'no poll reads the listing of a finished item');
  } finally {
    endUpkeep();
    mock.timers.reset();
    delete globalThis.chrome;
  }
});

test('a take-down finished during the wait after its listing tab opened stays done: no poll starts on it, so a tab closed later does not replace the banner', async () => {
  let tabGone = false;
  const reads = [];
  globalThis.chrome = {
    ...fakeChrome({}, TAKE_DOWN_STORE()),
    tabs: { create: async () => ({ id: 9 }), get: async (id) => { if (tabGone) throw new Error('No tab with id: 9'); return { id, url: LISTED_PAGE.url }; } },
    runtime: { sendMessage: async () => ({}) },
    scripting: { executeScript: async () => { reads.push(1); if (tabGone) throw new Error('No tab with id: 9'); return [{ result: { ...LISTED_PAGE } }]; } },
  };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const ctx = { render: () => {}, map: () => FORM_MAP, nextItem: async () => null };
  const started = startUpkeep(TAKE_DOWN, ctx);
  try {
    await settle();
    assert.equal(up.status, 'waiting', 'the listing is open, and the wait before its first read runs');
    assert.equal(await handleUpkeepClick('upkeepDoneBtn', ctx), true);
    assert.equal(up.status, 'done');
    mock.timers.tick(1500); // the wait ends after I took the car down
    await started;
    tabGone = true; // then the person closes the listing tab
    mock.timers.tick(1500);
    await settle();
    assert.equal(reads.length, 0, 'no poll reads the listing of a finished item');
    assert.equal(up.status, 'done', 'the done banner is not replaced by the tab-closed answer');
  } finally {
    endUpkeep();
    mock.timers.reset();
    delete globalThis.chrome;
  }
});

test('a take-down finished while its first write is still under way when the wait ends leaves no poll on the item', async () => {
  const reads = [];
  const fake = fakeChrome({}, TAKE_DOWN_STORE());
  const set = fake.storage.local.set;
  let release = null;
  fake.storage.local.set = (obj) => (release ? set(obj) : new Promise((resolve) => { release = () => set(obj).then(resolve); }));
  globalThis.chrome = {
    ...fake,
    tabs: { create: async () => ({ id: 9 }), get: async (id) => ({ id, url: LISTED_PAGE.url }) },
    runtime: { sendMessage: async () => ({}) },
    scripting: { executeScript: async () => { reads.push(1); return [{ result: { ...LISTED_PAGE } }]; } },
  };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const ctx = { render: () => {}, map: () => FORM_MAP, nextItem: async () => null };
  const started = startUpkeep(TAKE_DOWN, ctx);
  try {
    await settle();
    assert.equal(up.status, 'waiting', 'the listing is open, and the wait before its first read runs');
    const clicked = handleUpkeepClick('upkeepDoneBtn', ctx); // the first write is held
    await settle();
    mock.timers.tick(1500); // the wait ends while the writes are still held
    await started;
    release(); // the writes finish now
    assert.equal(await clicked, true);
    assert.equal(up.status, 'done');
    mock.timers.tick(1500);
    await settle();
    assert.equal(reads.length, 0, 'no poll reads the listing of a finished item');
  } finally {
    endUpkeep();
    mock.timers.reset();
    delete globalThis.chrome;
  }
});

// A To do item finished while its listing tab is still opening, and the tab fails to open while the finish reads the account:
// startUpkeep's catch still draws that failure, since the item is not done yet, but the finish sets the item done after the read
// and clears the error with it.
test('a take-down finished while its listing tab is still opening, and the tab fails to open while the finish reads the account, stays done with no error', async () => {
  let failOpen = null;
  globalThis.chrome = {
    ...fakeChrome({}, TAKE_DOWN_STORE()),
    tabs: { create: () => new Promise((resolve, reject) => { failOpen = reject; }) },
    runtime: { sendMessage: async () => ({}) },
    scripting: { executeScript: async () => [{ result: { ...LISTED_PAGE } }] },
  };
  // the finish's account read, which comes after its writes, waits until the test answers it
  const get = chrome.storage.local.get;
  let holding = false;
  let releaseAccount = null;
  chrome.storage.local.get = (keys) => {
    if (!holding || ![keys].flat().includes(GLOBAL_KEYS.account)) return get(keys);
    holding = false;
    return new Promise((resolve) => { releaseAccount = () => get(keys).then(resolve); });
  };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const ctx = { render: () => {}, map: () => FORM_MAP, nextItem: async () => null };
  const started = startUpkeep(TAKE_DOWN, ctx);
  try {
    await settle();
    assert.equal(up.status, 'opening', 'the listing tab is still being opened');
    holding = true;
    const done = handleUpkeepClick('upkeepDoneBtn', ctx); // I took the car down
    await settle();
    assert.equal(typeof releaseAccount, 'function', 'the finish is reading the account, after its writes');
    failOpen(new Error('no tab for you')); // the tab fails to open while the finish waits
    await started;
    releaseAccount();
    assert.equal(await done, true);
    assert.equal(up.status, 'done', 'the finished item is not set to open-failed');
    assert.equal(up.error, '', 'and no error is written on it');
    assert.match(upkeepHtml(), /id="upkeepDone"/, 'the done banner stays');
    assert.doesNotMatch(upkeepHtml(), /upkeepOpenFailed|Couldn&#39;t open/);
  } finally {
    chrome.storage.local.get = get;
    if (releaseAccount) releaseAccount(); // a read left held would keep the finish waiting for the tests after this one
    endUpkeep();
    mock.timers.reset();
    delete globalThis.chrome;
  }
});

// A To do item finished while its listing tab is still opening, and the tab then fails to open: the failure is about the
// finished item, so it sets no open-failed status and no error on it (startUpkeep's catch checks over()).
test('a take-down finished while its listing tab is still opening, and the tab then fails to open, stays done with no error', async () => {
  let failOpen = null;
  globalThis.chrome = {
    ...fakeChrome({}, TAKE_DOWN_STORE()),
    tabs: { create: () => new Promise((resolve, reject) => { failOpen = reject; }) },
    runtime: { sendMessage: async () => ({}) },
    scripting: { executeScript: async () => [{ result: { ...LISTED_PAGE } }] },
  };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const ctx = { render: () => {}, map: () => FORM_MAP, nextItem: async () => null };
  const started = startUpkeep(TAKE_DOWN, ctx);
  try {
    await settle();
    assert.equal(up.status, 'opening', 'the listing tab is still being opened');
    assert.equal(await handleUpkeepClick('upkeepDoneBtn', ctx), true);
    assert.equal(up.status, 'done');
    failOpen(new Error('no tab for you')); // the tab fails to open after I took the car down
    await started;
    assert.equal(up.status, 'done', 'the finished item is not set to open-failed');
    assert.equal(up.error, '', 'and no error is written on it');
    assert.match(upkeepHtml(), /id="upkeepDone"/, 'the done banner stays');
    assert.doesNotMatch(upkeepHtml(), /upkeepOpenFailed|Couldn&#39;t open/);
  } finally {
    endUpkeep();
    mock.timers.reset();
    delete globalThis.chrome;
  }
});

test('a take-down whose listing tab answers after another To do item started sets no tab or status on that item', async () => {
  const opens = []; // the tab each item asks for, in order: the test answers each one
  globalThis.chrome = {
    ...fakeChrome({}, {}),
    tabs: { create: () => new Promise((resolve) => { opens.push(resolve); }) },
    runtime: { sendMessage: async () => ({}) },
    scripting: { executeScript: async () => [{ result: null }] },
  };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const ctx = { render: () => {}, map: () => FORM_MAP, nextItem: async () => null };
  const CAR_B = { origin: 'https://www.example-motors.test', vin: 'bbb', kind: 'takeDown', why: 'gone', name: 'Car B', listingUrl: at('222'), listedPrice: 21000 };
  const first = startUpkeep(TAKE_DOWN, ctx);
  try {
    await settle();
    assert.equal(up.status, 'opening', 'car A\'s listing tab is being opened');
    endUpkeep(); // Not now on car A
    const second = startUpkeep(CAR_B, ctx);
    await settle();
    assert.deepEqual([up.vin, up.status, up.tabId], ['BBB', 'opening', null], 'car B starts while car A\'s tab is still being opened');
    opens[0]({ id: 9 }); // car A's tab opens now
    await settle();
    assert.deepEqual([up.vin, up.status, up.tabId], ['BBB', 'opening', null], 'car A\'s tab writes no tab or status on car B');
    await first;
    opens[1]({ id: 10 });
    await settle();
    mock.timers.tick(1500);
    await second;
    assert.deepEqual([up.vin, up.status, up.tabId], ['BBB', 'waiting', 10], 'car B\'s own tab opens as it would have');
  } finally {
    endUpkeep();
    mock.timers.reset();
    delete globalThis.chrome;
  }
});

test('a take-down whose wait ends after another To do item started starts no poll: car B is first read when its own wait ends', async () => {
  const reads = [];
  globalThis.chrome = {
    ...fakeChrome({}, {}),
    tabs: { create: async () => ({ id: 9 }), get: async (id) => ({ id, url: LISTED_PAGE.url }) },
    runtime: { sendMessage: async () => ({}) },
    scripting: { executeScript: async () => { reads.push(1); return [{ result: { ...LISTED_PAGE, url: at('222') } }]; } },
  };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const ctx = { render: () => {}, map: () => FORM_MAP, nextItem: async () => null };
  const CAR_B = { origin: 'https://www.example-motors.test', vin: 'bbb', kind: 'takeDown', why: 'gone', name: 'Car B', listingUrl: at('222'), listedPrice: 21000 };
  const first = startUpkeep(TAKE_DOWN, ctx);
  try {
    await settle();
    assert.equal(up.status, 'waiting', 'car A\'s listing is open, and its wait runs');
    mock.timers.tick(1000); // car A's wait has 500 ms to go
    endUpkeep(); // Not now on car A
    const second = startUpkeep(CAR_B, ctx);
    await settle();
    assert.deepEqual([up.vin, up.status], ['BBB', 'waiting'], 'car B\'s listing is open, and its wait runs');
    mock.timers.tick(500); // car A's wait ends
    await settle();
    await first;
    mock.timers.tick(1000); // car B's wait ends
    await settle();
    await second;
    mock.timers.tick(500); // 1.5 s after car A's wait ended, a poll that car A started would read car B
    await settle();
    assert.equal(reads.length, 0, 'no poll reads car B before 1.5 s after its own wait ended');
    mock.timers.tick(1000); // car B's first read, 1.5 s after its wait ended
    await settle();
    assert.equal(reads.length, 1, 'car B is read once, 1.5 s after its own wait ended');
  } finally {
    endUpkeep();
    mock.timers.reset();
    delete globalThis.chrome;
  }
});

// A tab that fails to open after another To do item started is about the item it was opened for: the new item keeps its
// status, error and note, and its own tab opens as it would have.
test('a tab that fails to open after another To do item started leaves the new item\'s status, error and note alone', async () => {
  const opens = []; // the tab each item asks for, in order: the test answers each one
  globalThis.chrome = {
    ...fakeChrome({}, {}),
    tabs: { create: () => new Promise((resolve, reject) => { opens.push({ resolve, reject }); }) },
    runtime: { sendMessage: async () => ({}) },
    scripting: { executeScript: async () => [{ result: null }] },
  };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const ctx = { render: () => {}, map: () => FORM_MAP, nextItem: async () => null };
  const CAR_B = { origin: 'https://www.example-motors.test', vin: 'bbb', kind: 'takeDown', why: 'gone', name: 'Car B', listingUrl: at('222'), listedPrice: 21000 };
  const first = startUpkeep(TAKE_DOWN, ctx);
  try {
    await settle();
    assert.equal(up.status, 'opening', 'car A\'s listing tab is being opened');
    endUpkeep(); // Not now on car A
    const second = startUpkeep(CAR_B, ctx);
    await settle();
    assert.deepEqual([up.vin, up.status], ['BBB', 'opening'], 'car B starts while car A\'s tab is still being opened');
    opens[0].reject(new Error('no tab for car A')); // car A's tab fails to open now
    await first;
    assert.deepEqual([up.vin, up.status, up.error, up.note], ['BBB', 'opening', '', ''], 'car A\'s failure writes no status, error or note on car B');
    opens[1].resolve({ id: 10 });
    await settle();
    mock.timers.tick(1500);
    await second;
    assert.deepEqual([up.vin, up.status, up.tabId], ['BBB', 'waiting', 10], 'car B\'s own tab opens as it would have');
  } finally {
    endUpkeep();
    mock.timers.reset();
    delete globalThis.chrome;
  }
});

// A listing read that fails after another To do item started is about the old item's tab, so it writes nothing on
// the new item and looks at no tab for it. Here the new item is still checking its price, so it has no tab yet.
test('a listing read that fails after another To do item started writes nothing on that item, and looks at no tab for it', async () => {
  const origin = 'https://www.example-motors.test';
  const r = await raceRig({ origin, vin: 'aaa', kind: 'takeDown', why: 'gone', name: 'Car A', listingUrl: at('111'), listedPrice: 20000 });
  const tabsGet = chrome.tabs.get;
  const looked = [];
  chrome.tabs.get = (id) => { looked.push(id); return tabsGet(id); };
  let answerPrice = null;
  r.ctx.priceNow = () => new Promise((resolve) => { answerPrice = resolve; }); // car B's price read is held
  try {
    r.holdRead = true;
    await r.tick(); // a poll starts and waits on the listing read
    assert.ok(r.heldRead, 'the read is in flight');
    const next = startUpkeep({ origin, vin: 'bbb', kind: 'price', price: 30000, listingUrl: at('222'), name: 'Car B', listedPrice: 31000 }, r.ctx);
    await r.flush();
    assert.deepEqual([up.vin, up.status, up.tabId], ['BBB', 'checking', null], 'car B is checking its price, with no tab yet');
    const looksBefore = looked.length;
    r.tabGone = true; // car A's tab has closed
    r.heldRead.fail(new Error('No tab with id: 9'));
    await r.flush();
    assert.deepEqual([up.vin, up.status, up.note, up.offTarget], ['BBB', 'checking', '', false], 'car A\'s failed read writes nothing on car B');
    assert.deepEqual(looked.slice(looksBefore), [], 'and looks at no tab for car B');
    answerPrice({ ok: true, price: 30000, basis: 'website' });
    await r.flush();
    await r.tick();
    await next;
    assert.equal(up.status, 'waiting');
  } finally {
    chrome.tabs.get = tabsGet;
    await endRaceRig(r);
  }
});

// The tab lookup a failed read makes (poll) is held while another To do item starts: a failure that answers after that
// writes nothing on the new item, which is checking its price and has no tab yet.
test('a tab lookup that fails after another To do item started writes nothing on that item', async () => {
  const origin = 'https://www.example-motors.test';
  const r = await raceRig({ origin, vin: 'aaa', kind: 'takeDown', why: 'gone', name: 'Car A', listingUrl: at('111'), listedPrice: 20000 });
  const tabsGet = chrome.tabs.get;
  let holdLookup = false;
  let heldLookup = null;
  chrome.tabs.get = (id) => { if (!holdLookup) return tabsGet(id); holdLookup = false; return new Promise((resolve, reject) => { heldLookup = { resolve, reject }; }); };
  let answerPrice = null;
  r.ctx.priceNow = () => new Promise((resolve) => { answerPrice = resolve; }); // car B's price read is held
  try {
    r.holdRead = true;
    await r.tick(); // a poll starts and waits on the listing read
    assert.ok(r.heldRead, 'the read is in flight');
    holdLookup = true;
    r.heldRead.fail(new Error('Cannot access contents of the page')); // the read fails: the poll looks car A's tab up
    await r.flush();
    assert.ok(heldLookup, 'the tab lookup is in flight');
    const next = startUpkeep({ origin, vin: 'bbb', kind: 'price', price: 30000, listingUrl: at('222'), name: 'Car B', listedPrice: 31000 }, r.ctx);
    await r.flush();
    assert.deepEqual([up.vin, up.status, up.tabId], ['BBB', 'checking', null], 'car B is checking its price, with no tab yet');
    heldLookup.reject(new Error('No tab with id: 9')); // car A's tab has closed
    await r.flush();
    assert.deepEqual([up.vin, up.status, up.note, up.offTarget], ['BBB', 'checking', '', false], 'car A\'s failed lookup writes nothing on car B');
    answerPrice({ ok: true, price: 30000, basis: 'website' });
    await r.flush();
    await r.tick();
    await next;
    assert.equal(up.status, 'waiting');
  } finally {
    chrome.tabs.get = tabsGet;
    await endRaceRig(r);
  }
});

// The same lookup answering once car B has its tab, on another page: the answer writes no note on car B.
test('a tab lookup that answers after another To do item started writes no note on that item, even when its tab is on another page', async () => {
  const origin = 'https://www.example-motors.test';
  const r = await raceRig({ origin, vin: 'aaa', kind: 'takeDown', why: 'gone', name: 'Car A', listingUrl: at('111'), listedPrice: 20000 });
  const tabsGet = chrome.tabs.get;
  let holdLookup = false;
  let heldLookup = null;
  chrome.tabs.get = (id) => { if (!holdLookup) return tabsGet(id); holdLookup = false; return new Promise((resolve) => { heldLookup = resolve; }); };
  try {
    r.holdRead = true;
    await r.tick(); // a poll starts and waits on the listing read
    assert.ok(r.heldRead, 'the read is in flight');
    holdLookup = true;
    r.heldRead.fail(new Error('Cannot access contents of the page')); // the read fails: the poll looks car A's tab up
    await r.flush();
    assert.ok(heldLookup, 'the tab lookup is in flight');
    const next = startUpkeep({ origin, vin: 'bbb', kind: 'takeDown', why: 'gone', name: 'Car B', listingUrl: at('222'), listedPrice: 21000 }, r.ctx);
    await r.flush();
    await r.tick();
    await next;
    assert.deepEqual([up.vin, up.status, up.tabId], ['BBB', 'waiting', 9], 'car B has its tab');
    heldLookup({ id: 9, url: 'https://www.facebook.com/home' }); // car A's tab answers: on another page
    await r.flush();
    assert.deepEqual([up.vin, up.status, up.note, up.offTarget], ['BBB', 'waiting', '', false], 'car A\'s lookup writes no note on car B');
  } finally {
    chrome.tabs.get = tabsGet;
    await endRaceRig(r);
  }
});

// A take-down recorded without its name makes namesakesNow read the last scan for the names (its second storage read),
// and that read can be in flight when another To do item starts. The read was made for car A, so car B keeps none
// (up.names stays null) and its state is the one startUpkeep gave it.
test('a last-scan read still in flight when another To do item starts writes no names onto that item', async () => {
  const origin = 'https://www.example-motors.test';
  const k = siteKeys(origin);
  const T = (h) => new Date(Date.UTC(2026, 9, 5, h)).toISOString();
  const store = {
    [k.takenDown]: noteTakenDown(null, { vin: 'AAA', postedAt: T(1) }, T(2), T(2)), // car A's take-down, recorded without its name
    [k.snapshot]: { vehicles: { AAA: { name: 'Car A' }, BBB: { name: 'Car B' } } },
  };
  const r = await raceRig({ origin, vin: 'aaa', kind: 'takeDown', why: 'gone', name: 'Car A', listingUrl: '', listedPrice: 20000 }, store);
  // the last scan is read for car A's namesakes, and that read is held until the test answers it
  const get = chrome.storage.local.get;
  let answerScan = null;
  chrome.storage.local.get = (keys) => {
    if (![keys].flat().includes(k.snapshot)) return get(keys);
    return new Promise((resolve) => { answerScan = () => get(keys).then(resolve); });
  };
  try {
    await r.tick(); // car A's first poll: no listing id, so its namesakes are read, and the last scan read is held
    assert.ok(answerScan, 'the last-scan read is in flight');
    // another item starts while that read is in flight
    const next = startUpkeep({ origin, vin: 'bbb', kind: 'takeDown', why: 'gone', name: 'Car B', listingUrl: at('222'), listedPrice: 21000 }, r.ctx);
    await r.flush();
    await r.tick();
    await next;
    assert.equal(up.vin, 'BBB');
    answerScan(); // the last scan answers now, after car B has started
    await r.flush();
    assert.equal(up.names, null, 'car A\'s read writes no names onto car B');
    assert.deepEqual([up.vin, up.status], ['BBB', 'waiting'], 'car B keeps the state startUpkeep gave it');
  } finally {
    await endRaceRig(r);
  }
});
