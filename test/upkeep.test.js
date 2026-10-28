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
import { noteTakenDown } from '../extension/src/takenDown.js';
import { siteKeys } from '../extension/src/storageKeys.js';
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
  endUpkeep();
});

// The price update's poll, driven on node's fake timers (the side panel's 1.5 s
// interval): the tab shows rig.page to the in-page reads, every fill is refused
// (the form keeps its own price), and each tick() runs one poll. Call endRig()
// in a finally and await rig.started after it.
const WANT_PRICE = 18500;
const LISTED_PAGE = { url: at('111'), matchesId: true, sold: false, unavailable: false, matchesVin: false, vinInText: false, matchesName: true, matchesPrice: true, prices: ['20000'], formOnPage: true, hasPriceBox: true, priceBoxValue: '20000' };
async function priceRig(page, { nextItem } = {}) {
  const rig = { page: { ...page }, fills: 0 };
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
  rig.tick = async () => { mock.timers.tick(1500); await flush(); };
  globalThis.chrome = {
    ...fakeChrome({}, {}),
    tabs: { create: async () => ({ id: 9 }), get: async (id) => ({ id, url: rig.page.url }) },
    runtime: { sendMessage: async () => ({}) },
    scripting: {
      executeScript: async ({ func }) => {
        if (func === readListingInPage) return [{ result: { ...rig.page } }];
        if (func === fillPriceInPage) {
          rig.fills += 1;
          return [{ result: { ok: false, reason: 'The Price box did not take the price.' } }];
        }
        throw new Error('an unexpected in-page script');
      },
    },
  };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const ctx = { render: () => {}, map: () => FORM_MAP, priceNow: async () => ({ ok: true, price: WANT_PRICE, basis: 'website' }), nextItem };
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
  const ctx = { render: noop, map: () => FORM_MAP, nextItem: () => { asked += 1; return new Promise((resolve) => { answer = resolve; }); }, onClose: noop };
  try {
    Object.assign(up, { ...DONE_CAR, hasNext: true });
    const first = handleUpkeepClick('upkeepNext', ctx);
    assert.equal(up.status, 'finding', 'the status turns to finding before anything is awaited');
    assert.match(upkeepHtml(), /Finding the next To do item/);
    assert.doesNotMatch(upkeepHtml(), /upkeepNext/, 'the button is not drawn while the next item is found');
    assert.match(upkeepHtml(), /id="upkeepClose"/, 'Close is the one button drawn while the next item is found');
    assert.doesNotMatch(upkeepHtml(), /upkeepDoneBtn|upkeepCancel/, 'no I took it down or Not now while the next item is found');
    assert.doesNotMatch(upkeepHtml(), /upkeepNote|Marked done\./, 'the done note is not repeated under the finding line');
    assert.equal(await handleUpkeepClick('upkeepNext', ctx), true);
    assert.equal(asked, 1, 'the second click asks for nothing');
    answer(null);
    assert.equal(await first, true);
    assert.equal(up.status, 'done', 'no item came back: the done banner is restored');
    assert.equal(up.hasNext, false);
  } finally {
    endUpkeep();
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
  const ctx = { render: noop, map: () => FORM_MAP, nextItem: async () => null, onClose: noop };
  try {
    Object.assign(up, { ...DONE_CAR, hasNext: true });
    assert.equal(await handleUpkeepClick('upkeepNext', ctx), true);
    assert.equal(up.status, 'done');
    assert.equal(up.hasNext, false);
    const html = upkeepHtml();
    assert.match(html, /id="upkeepDone"/);
    assert.doesNotMatch(html, /upkeepNext/);
    assert.match(html, /id="upkeepClose"/);
  } finally {
    endUpkeep();
  }
});

test('when the next To do item cannot be found, the done banner stays and no Next button is drawn', async () => {
  const ctx = { render: noop, map: () => FORM_MAP, nextItem: async () => { throw new Error('storage is unavailable'); }, onClose: noop };
  try {
    Object.assign(up, { ...DONE_CAR, hasNext: true });
    assert.equal(await handleUpkeepClick('upkeepNext', ctx), true);
    assert.equal(up.status, 'done');
    assert.equal(up.hasNext, false);
    assert.match(upkeepHtml(), /id="upkeepDone"/);
    assert.doesNotMatch(upkeepHtml(), /upkeepNext/);
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
    const ctx = {
      render: noop,
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
// the question fails.
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
      rig.page = { ...UPDATED_PAGE }; // the listing shows the new price: the item is done
      await rig.tick();
      assert.equal(up.status, 'done');
      assert.match(upkeepHtml(), /id="upkeepDone"/, 'the done banner shows');
      assert.equal(/id="upkeepNext"/.test(upkeepHtml()), offered, `button drawn: ${offered}`);
    } finally {
      endRig();
      await rig.started;
    }
  }
});
