// The popup (extension/popup.js), clicked through in Node over
// test/popupHarness.js: what its buttons write and what its tabs draw.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPopup, POPUP_ORIGIN } from './popupHarness.js';
import { fixtures, raw, vehicle, sampleVin, MY_STORE } from './helpers.js';
import { PROFILE_KEY } from '../extension/src/settings.js';
import { siteKeys } from '../extension/src/storageKeys.js';
import { POSTING_RULES } from '../extension/src/postingRules.js';
import { noteFlags, resolveFlag, beginPost, endPost, noteFill, notePostStep } from '../extension/src/pilot.js';
import { STORAGE_FULL } from '../extension/src/storage.js';

const k = siteKeys(POPUP_ORIGIN);

// The person's synced profile (src/settings.js profileFrom), saved on this website.
const PROFILE = {
  origin: POPUP_ORIGIN,
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
};

test('Clear everything for this website, then Rescan as the status line says, puts the synced profile back instead of defaults over it', async () => {
  const settings = { ...structuredClone(PROFILE), rewrite: { ...PROFILE.rewrite, key: 'typed-key' } };
  const p = await loadPopup({ local: { [k.settings]: settings }, sync: { [PROFILE_KEY]: structuredClone(PROFILE) } });
  await p.click('clear');
  await p.click('clear'); // "Click again to clear everything"
  assert.match(p.status(), /Cleared/);
  assert.equal(p.local[k.settings], undefined, 'the website\'s settings are gone');
  await p.scan();
  assert.equal(p.status(), '', 'the scan went through');

  const q = p.sync[PROFILE_KEY];
  assert.deepEqual(q.salesperson, PROFILE.salesperson, 'name, role and closing line are kept');
  assert.deepEqual(q.defaults, PROFILE.defaults, 'the listing defaults are kept');
  assert.deepEqual(q.rewrite, PROFILE.rewrite, 'the rewrite address is kept');
  assert.deepEqual(q.legal, PROFILE.legal);
  assert.equal(q.dailyCap, 5, 'saved on this website, the cap comes back');
  assert.equal(q.priceNote, PROFILE.priceNote);
  const s = p.local[k.settings];
  assert.equal(s.salesperson.closingLine, PROFILE.salesperson.closingLine, 'and this website starts again from the profile');
  assert.equal(s.rewrite.key, '', 'the key typed on this computer was cleared with the website, as before');
});

test('My listings counts only the person\'s own listings; a colleague\'s come in their own section with no buttons, and To do and Ready say whose they are', async () => {
  const own = vehicle('usedZeroMiles');
  const theirs = vehicle('usedNormal'); // ready to post at the store MY_STORE names
  const gone = sampleVin(7, 2020); // a colleague's car the website no longer lists
  const at = new Date().toISOString();
  const colleague = { mine: false, userId: 'colleague-id', salesperson: 'Pat' }; // as src/sync.js mergeRegistry writes it
  const posted = {
    [own.vin]: { name: own.name, price: own.price, postedAt: at },
    [theirs.vin]: { name: theirs.name, price: theirs.price, postedAt: at, listingUrl: 'https://www.facebook.com/marketplace/item/1001/', ...colleague },
    [gone]: { name: '2020 Example Truck', price: 20000, postedAt: at, ...colleague },
  };
  const p = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, [k.posted]: posted } });
  await p.scan();
  assert.equal(p.status(), '', 'the scan went through');
  assert.match(p.tabs(), /My listings<span class="count">1<\/span>/, 'the tab counts the person\'s own listing only');

  const todo = p.panel();
  assert.match(todo, /Gone from the website \(sold or removed\) · posted by Pat/, 'To do says whose listing the sold car is');
  assert.doesNotMatch(todo, /not marked as posted/);
  assert.doesNotMatch(todo, new RegExp(`data-vin="${gone}"`), 'and offers no button on it');

  await p.tab('mine');
  const [ownPart, theirPart = ''] = p.panel().split('id="colleagueListings"');
  assert.match(ownPart, new RegExp(`data-action="takenDown" data-vin="${own.vin}"`));
  assert.ok(!ownPart.includes(theirs.name) && !ownPart.includes(gone), 'a colleague\'s listing is not among the person\'s own');
  assert.match(theirPart, /Posted by colleagues <span class="pill">2<\/span>/);
  assert.match(theirPart, /Posted by Pat/);
  assert.match(theirPart, /href="https:\/\/www\.facebook\.com\/marketplace\/item\/1001\/"/, 'with the link to the listing');
  assert.doesNotMatch(theirPart, /data-action=/, 'no Taken down or Updated on a colleague\'s listing');

  await p.tab('ready');
  assert.match(p.panel(), /Posted by Pat/, 'the Ready tab says who posted the car');
  assert.doesNotMatch(p.panel(), new RegExp(`data-action="unpost" data-vin="${theirs.vin}"`), 'and offers no unmarking of it');

  // The website lowers the price of the colleague's car: To do says it is theirs.
  const lower = Number(raw('usedNormal').extra_fields.lightning.pricing.low.value) - 1000;
  const records = Object.entries(fixtures).filter(([name]) => name !== '_about').map(([name]) => (name === 'usedNormal' ? raw(name, { extra_fields: { lightning: { pricing: { low: { value: lower } } } } }) : raw(name)));
  const again = await loadPopup({ local: p.local, records });
  await again.scan();
  assert.ok((again.local[k.diff].priceUpdates || []).some((u) => u.vin === theirs.vin && !u.yours), 'the price change is found');
  assert.match(again.panel(), /Posted by Pat/);
  assert.doesNotMatch(again.panel(), /Not marked as posted/);
});

// Non-negotiable 7: the day's cap counts the day's posts. Taken down and
// unmarking Posted ✓ remove the car from the posted list, but the post was
// made: the cap must not give the slot back.
test('at the daily cap, Taken down or unmarking Posted ✓ on one of today\'s posts does not bring Post back', async () => {
  const car = vehicle('usedNormal'); // the one car ready to post at MY_STORE
  for (const action of ['takenDown', 'unpost']) {
    const posted = { [car.vin]: { name: car.name, price: car.price, postedAt: new Date().toISOString() } };
    const p = await loadPopup({ local: { [k.settings]: { ...MY_STORE, dailyCap: 1 }, [k.posted]: posted } });
    await p.scan();
    assert.equal(p.status(), '', 'the scan went through');
    await p.click(action, { vin: car.vin });
    assert.deepEqual(p.local[k.posted], {}, `${action}: the car left the posted list`);
    const kept = p.local[k.takenDown];
    assert.equal(kept.length, 1, `${action}: the post is kept for the cap`);
    assert.deepEqual([kept[0].vin, kept[0].postedAt, kept[0].stillListed], [car.vin, posted[car.vin].postedAt, true], 'the website still lists the car as ready');
    assert.equal(kept[0].name, car.name, `${action}: its name is kept, so a listing still up counts among the cars of that name`);
    await p.tab('ready');
    assert.match(p.panel(), new RegExp(`data-action="openPost" data-vin="${car.vin}" disabled`), `${action}: Post stays off at 1 of 1`);
    await p.click('openPost', { vin: car.vin });
    assert.match(p.status(), /Daily post cap reached \(1 of 1 today\)/);
    assert.equal(p.local.postRequest, undefined, 'nothing is handed to the side panel');
  }
});

// The posting rules are shown before posting: set-up shows them, and
// whoever clicks Not now on the set-up banner meets them in the side panel
// before the first post (test/panelFlow.test.js) or in Settings, which now
// has them, as the Not now button says.
test('Not now says where the posting rules are; Settings shows them, and its tick is saved like set-up\'s', async () => {
  const p = await loadPopup({ local: { [k.settings]: { ...MY_STORE } } });
  await p.scan();
  assert.match(p.panel(), /data-action="skipSetup" title="Settings has the same fields, the posting rules included">Not now/);
  await p.click('skipSetup');
  assert.equal(p.status(), 'Settings has the same fields, the posting rules included. The side panel shows the rules before your first post until you tick them. Set-up can be run later after "Clear everything for this website".');

  await p.tab('settings');
  const settings = p.panel();
  assert.match(settings, /<legend>Posting rules<\/legend>/);
  const html = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  for (const rule of POSTING_RULES) assert.ok(settings.includes(html(rule.title)) && settings.includes(html(rule.text)), `Settings shows "${rule.title}"`);
  assert.match(settings, /id="rulesStatus">Not ticked yet for this website: the side panel shows them before your first post, or tick here\./);
  assert.match(settings, /<input type="checkbox" name="rulesAccept" \/> <span>I have read the posting rules and will follow them<\/span>/);

  // Save settings with the tick
  const values = { salespersonName: 'Sam', dailyCap: '10', rulesAccept: 'on' };
  const before = globalThis.FormData;
  globalThis.FormData = class { get(name) { return values[name] ?? null; } getAll() { return []; } has(name) { return name in values; } };
  try {
    await p.el('panel').listeners.submit({ target: { id: 'settings', querySelector: () => null }, preventDefault() {} });
  } finally {
    globalThis.FormData = before;
  }
  const at = p.local[k.settings].rulesReadAt;
  assert.ok(Date.parse(at) > 0, 'the tick is saved as rulesReadAt, the field set-up and the side panel read');
  await p.tab('settings');
  assert.match(p.panel(), /id="rulesStatus">You ticked that you will follow them on /);
  assert.doesNotMatch(p.panel(), /name="rulesAccept"/);
});

// Before a website's first scan the popup knows only its address. A Settings
// save or a sign-in then must not store the address as the dealership's name
// with no store ticked: the first scan fills in the name the website gives
// and ticks the store named after the website, as it does with no settings.
test('saving Settings or signing in before the website\'s first scan leaves the dealership name and the store for that scan to fill in', async () => {
  const STORE = MY_STORE.myStores[0]; // the site is named after one of the fixture lot's stores
  const host = new URL(POPUP_ORIGIN).hostname;
  const valueIn = (html, name) => (new RegExp(`name="${name}" value="([^"]*)"`).exec(html) || [])[1] ?? null;
  const submitSettings = async (p) => {
    await p.tab('settings');
    // the form posts what its boxes hold: the person types only their name
    const values = { salespersonName: 'Sam', dealerName: valueIn(p.panel(), 'dealerName'), dailyCap: '10' };
    const before = globalThis.FormData;
    globalThis.FormData = class { get(name) { return values[name] ?? null; } getAll() { return []; } has(name) { return name in values; } };
    try {
      await p.el('panel').listeners.submit({ target: { id: 'settings', querySelector: () => null }, preventDefault() {} });
    } finally {
      globalThis.FormData = before;
    }
  };
  const signIn = async (p) => {
    const boxes = { accountEmail: 'sam@example.test', accountCode: '123456' };
    const query = globalThis.document.querySelector;
    const fetchBefore = globalThis.fetch;
    globalThis.document.querySelector = (sel) => { const m = /\[name="(\w+)"\]/.exec(sel); return m && m[1] in boxes ? { value: boxes[m[1]] } : null; };
    globalThis.fetch = async (url) => (String(url).endsWith('/auth/v1/verify')
      ? { ok: true, status: 200, json: async () => ({ access_token: 'a.e30.c', refresh_token: 'r', expires_in: 3600, user: { id: 'u1', email: boxes.accountEmail } }) }
      : { ok: false, status: 404, json: async () => ({}) });
    try {
      await p.click('accountSignIn');
    } finally {
      globalThis.document.querySelector = query;
      globalThis.fetch = fetchBefore;
    }
    assert.match(p.status(), /Synced|Sync failed|Signed in/, 'the sign-in went through');
  };
  for (const [how, before] of [['Save settings', submitSettings], ['Sign in', signIn]]) {
    const p = await loadPopup({ name: STORE });
    await before(p);
    const saved = p.local[k.settings];
    assert.ok(saved, `${how}: settings were saved`);
    assert.notEqual(saved.dealer.name, host, `${how}: the website's address is not stored as the dealership's name`);
    assert.notEqual(p.sync[PROFILE_KEY]?.dealer.name, host, `${how}: nor carried in the synced profile`);
    const profile = structuredClone(p.sync[PROFILE_KEY]); // Save settings writes it; a sign-in does not
    await p.scan();
    assert.equal(p.status(), '', `${how}: the scan went through`);
    const s = p.local[k.settings];
    assert.equal(s.dealer.name, STORE, `${how}: the first scan names the dealership as the website does`);
    assert.deepEqual(s.myStores, [STORE], `${how}: and ticks the website's own store`);
    const ready = Object.values(p.local[k.snapshot].vehicles).filter((v) => v.decision === 'ready');
    assert.ok(ready.length && ready.every((v) => v.location === STORE), `${how}: only this store's cars are ready to post`);
    assert.deepEqual(p.sync[PROFILE_KEY], profile, `${how}: the scan leaves the synced profile as the person saved it (on this website the scan fills the name in)`);
  }
  // Settings an earlier build saved that way (the address as the name, no
  // store) are put right by the website's first scan too.
  const p = await loadPopup({ name: STORE, local: { [k.settings]: { dealer: { name: host }, myStores: [], salesperson: { name: 'Sam' } } } });
  await p.scan();
  assert.equal(p.local[k.settings].dealer.name, STORE);
  assert.deepEqual(p.local[k.settings].myStores, [STORE]);
  assert.equal(p.local[k.settings].salesperson.name, 'Sam', 'what the person typed stays');
});

// "Leave all unticked to include every store" is a choice a person makes
// with the website's stores in view (Settings after a scan, set-up's store
// step). The website's first scan on another computer, or after Clear
// everything for this website, settles the stores only when no such choice
// was made: an every-store choice stands, and a Save before the first scan
// (no store boxes yet) leaves the stores as they were.
test("a person's choice of every store survives the website's first scan; a Save before a scan changes no store", async () => {
  const STORE = MY_STORE.myStores[0]; // the site is named after one of the fixture lot's three stores
  const submitStores = async (p, ticked, { reopen = true } = {}) => {
    if (reopen) await p.tab('settings');
    const values = { salespersonName: 'Sam', dailyCap: '10', dealerName: STORE };
    const before = globalThis.FormData;
    globalThis.FormData = class { get(name) { return values[name] ?? null; } getAll(name) { return name === 'store' ? ticked : []; } has(name) { return name in values; } };
    try {
      // the form as drawn: its store boxes are there only when the panel drew them
      const drawn = p.panel();
      await p.el('panel').listeners.submit({ target: { id: 'settings', querySelector: (sel) => (sel === 'input[name="store"]' && drawn.includes('name="store"') ? {} : null) }, preventDefault() {} });
    } finally {
      globalThis.FormData = before;
    }
  };
  const readyStores = (p) => [...new Set(Object.values(p.local[k.snapshot].vehicles).filter((v) => v.decision === 'ready').map((v) => v.location))].sort();

  // the first scan ticks the website's own store; the person unticks it in Settings: every store
  const p = await loadPopup({ name: STORE });
  await p.scan();
  assert.deepEqual(p.local[k.settings].myStores, [STORE]);
  await submitStores(p, []);
  assert.deepEqual(p.local[k.settings].myStores, []);
  assert.equal(p.local[k.settings].storesChosen, true, 'chosen with the stores in view');
  assert.equal(p.sync[PROFILE_KEY].storesChosen, true, 'and the synced profile carries it');
  await p.scan();
  const every = readyStores(p);
  assert.ok(every.length > 1, 'every store\'s cars are ready to post');

  // Clear everything for this website, then Rescan: the profile's choice comes back and the first scan keeps it
  await p.click('clear');
  await p.click('clear');
  await p.scan();
  assert.deepEqual(p.local[k.settings].myStores, [], 'still every store');
  assert.deepEqual(readyStores(p), every);

  // another computer: only the synced profile, no scan of the website yet
  const other = await loadPopup({ name: STORE, sync: { [PROFILE_KEY]: structuredClone(p.sync[PROFILE_KEY]) } });
  await other.scan();
  assert.deepEqual(other.local[k.settings].myStores, [], 'the profile\'s every-store choice stands');
  assert.deepEqual(readyStores(other), every);

  // a profile that never chose (saved before a scan): the first scan ticks the website's own store, as before
  const unchosen = await loadPopup({ name: STORE, sync: { [PROFILE_KEY]: { ...structuredClone(p.sync[PROFILE_KEY]), storesChosen: false } } });
  await unchosen.scan();
  assert.deepEqual(unchosen.local[k.settings].myStores, [STORE]);
  assert.deepEqual(readyStores(unchosen), [STORE]);

  // a Save before this computer's first scan (no store boxes drawn) keeps the profile's stores, ticked or every
  for (const [stores, after] of [[[], []], [[MY_STORE.myStores[0]], [STORE]]]) {
    const q = await loadPopup({ name: STORE, sync: { [PROFILE_KEY]: { ...structuredClone(p.sync[PROFILE_KEY]), myStores: stores } } });
    await submitStores(q, []);
    assert.deepEqual(q.local[k.settings].myStores, stores, 'the Save changed no store');
    assert.equal(q.local[k.settings].storesChosen, true);
    await q.scan();
    assert.deepEqual(q.local[k.settings].myStores, after);
  }

  // Settings opened before the first scan, and a scan (the service worker's,
  // or set-up's) finishes while it is open: the form keeps no store boxes, so
  // its Save is no store choice, and the stores that scan settled stand
  const donor = await loadPopup({ name: STORE });
  await donor.scan();
  const scanned = { snapshot: structuredClone(donor.local[k.snapshot]), settings: structuredClone(donor.local[k.settings]) };
  const racing = await loadPopup({ name: STORE, echo: true, sync: { [PROFILE_KEY]: { ...structuredClone(p.sync[PROFILE_KEY]), myStores: [], storesChosen: false } } });
  await racing.tab('settings');
  await new Promise((r) => setTimeout(r, 20)); // the popup's own writes have echoed
  assert.doesNotMatch(racing.panel(), /name="store"/, 'no store boxes before a scan');
  Object.assign(racing.local, { [k.snapshot]: scanned.snapshot, [k.settings]: scanned.settings });
  racing.storageChanged({ [k.snapshot]: { newValue: scanned.snapshot }, [k.settings]: { newValue: scanned.settings } });
  assert.doesNotMatch(racing.panel(), /name="store"/, 'Settings is not redrawn under the person');
  await submitStores(racing, [], { reopen: false });
  assert.deepEqual(racing.local[k.settings].myStores, [STORE], 'the store the scan settled stands');
  assert.notEqual(racing.local[k.settings].storesChosen, true, 'no every-store choice nobody made');
});

// A lot of 10 or more that really shrinks by more than half: each scan is
// held back as a likely website hiccup, and once two in a row read the same
// smaller list, To do says so with a button; only that click saves it.
test('a lot that keeps reading more than half smaller is offered on To do after two scans that agree, and only the click saves the smaller list', async () => {
  const records = Array.from({ length: 12 }, (_, i) => ({ ...structuredClone(fixtures.usedNormal), vin: sampleVin(i + 1), stock: `S${i + 1}` }));
  const p = await loadPopup({ records });
  await p.scan();
  const cars = () => Object.keys(p.local[k.snapshot].vehicles).length;
  assert.equal(cars(), 12);

  records.splice(4); // the website now lists 4 of the 12
  await p.scan();
  assert.equal(p.local[k.diff].unreliable, true);
  assert.equal(cars(), 12, 'the saved list stays');
  assert.equal(p.local[k.diff].withheld.scans, 1);
  assert.doesNotMatch(p.panel(), /acceptWithheld/, 'one short read is not offered');

  await p.scan();
  assert.equal(p.local[k.diff].withheld.scans, 2);
  assert.equal(cars(), 12, 'never replaced by a scan');
  assert.match(p.panel(), /id="withheld"/);
  assert.match(p.panel(), /each read about 4 cars on the website, where the saved list has 12 cars/);
  assert.match(p.panel(), /data-action="acceptWithheld">Use the new list of 4 cars</);

  await p.click('acceptWithheld');
  assert.equal(cars(), 4, 'the click saves the smaller list');
  assert.equal(p.local[k.diff].unreliable, false);
  assert.equal('withheld' in p.local[k.diff], false);
  assert.doesNotMatch(p.panel(), /acceptWithheld|disappeared at once/);
  assert.match(p.panel(), /id="withheldAccepted"/);

  // the next scan compares with the new list: no hiccup
  await p.scan();
  assert.equal(p.local[k.diff].unreliable, false);
  assert.equal(cars(), 4);
  assert.doesNotMatch(p.panel(), /withheld/);
});

// A posted listing with no price basis (brought by a sync from a computer
// on an older version) gets the one a scan reads its price on, and that
// basis goes up with the next sync to every computer. A read held back as a
// website hiccup records none, even when it is the only read since the post
// that shows the price on one basis: the next trusted read records it.
test('a scan held back as a website hiccup records no price basis for a listing; a trusted read after it does', async () => {
  const records = Array.from({ length: 12 }, (_, i) => ({ ...structuredClone(fixtures.usedNormal), vin: sampleVin(i + 1), stock: `S${i + 1}` }));
  const p = await loadPopup({ records });
  await p.scan();
  const vin = sampleVin(1);
  assert.equal(p.local[k.snapshot].vehicles[vin].priceBeforeFees, 26673, 'each car shows $27,163, or $26,673 before the fee');
  // posted at the lower second price after that scan, on another computer, and brought here by a sync with no basis
  await new Promise((r) => setTimeout(r, 5));
  p.local[k.posted] = { [vin]: { name: 'Ram', price: 26673, postedAt: new Date().toISOString() } };
  await new Promise((r) => setTimeout(r, 5));

  records.splice(4); // the website now lists 4 of the 12: a likely hiccup
  await p.scan();
  assert.equal(p.local[k.diff].unreliable, true);
  assert.equal(p.local[k.posted][vin].basis, undefined, 'nothing recorded from a read held back as a hiccup');

  await p.scan();
  await p.click('acceptWithheld'); // the salesperson uses the new list
  await p.scan();
  assert.equal(p.local[k.diff].unreliable, false);
  assert.equal(p.local[k.posted][vin].basis, 'beforeFees', 'the next trusted read records it');
});

// Clear the numbers is what the storage-full message sends people to. An
// open to-do item is still on To do, and its synced copy on the manager's
// list closes only when this computer closes it, so it stays.
test('Clear the numbers keeps the to-do items still open, says so, and clears the rest', async () => {
  const sold = vehicle('usedNormal');
  const other = vehicle('certified');
  let pilot = noteFlags(null, { takeDown: [{ vin: sold.vin, name: sold.name, yours: true, why: 'gone' }, { vin: other.vin, name: other.name, yours: true, why: 'gone' }], priceUpdates: [], warnings: [] }, { at: '2026-10-01T09:00:00.000Z' });
  pilot = resolveFlag(pilot, other.vin, null, { at: '2026-10-01T10:00:00.000Z', how: 'manual' });
  pilot = endPost(beginPost(pilot, { vin: other.vin, name: other.name, salesperson: 'Sam', at: '2026-09-30T09:00:00.000Z' }), other.vin, 'posted', { at: '2026-09-30T09:01:00.000Z' });
  pilot = noteFill(pilot, { vin: other.vin, fill: { filled: [{ key: 'price' }] }, at: '2026-09-30T09:00:30.000Z' });
  const p = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, [k.pilot]: pilot } });
  await p.tab('pilot');
  assert.match(p.panel(), /id="pilotClearNote">Clear the numbers keeps the to-do items still open, so they close as usual once done\. While you are signed in, it also keeps the items closed since the last sync until the next sync sends them, and it does not remove what has already synced to your dealership's account\./);
  await p.click('pilotClear');
  await p.click('pilotClear'); // "Click again to clear the numbers"
  assert.equal(p.status(), 'The numbers for this website were cleared. The to-do item still open stays until it is done.');
  const kept = p.local[k.pilot];
  assert.deepEqual(kept.flags, [pilot.flags[0]], 'the open item stays with its flagging time');
  assert.deepEqual([kept.posts, kept.fills], [[], []], 'the finished post and the fill are gone');

  // nothing open: the key goes, as before
  const q = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, [k.pilot]: resolveFlag(pilot, sold.vin, null, { at: '2026-10-01T11:00:00.000Z' }) } });
  await q.click('pilotClear');
  await q.click('pilotClear');
  assert.equal(q.status(), 'The numbers for this website were cleared.');
  assert.equal(q.local[k.pilot], undefined);
});

// The dealership's copy of a to-do item closes only when a sync sends the
// flag closed: a Taken down or Updated clicked since the last sync, then
// Clear the numbers, must not drop the closed flag before it goes up.
test('Clear the numbers keeps a to-do item closed since the last sync until the next sync sends it, and says so', async () => {
  const sold = vehicle('usedNormal');
  const other = vehicle('certified');
  const third = vehicle('usedZeroMiles');
  const gone = (car) => ({ vin: car.vin, name: car.name, yours: true, why: 'gone' });
  let pilot = noteFlags(null, { takeDown: [gone(sold), gone(other), gone(third)], priceUpdates: [], warnings: [] }, { at: '2026-10-01T09:00:00.000Z' });
  pilot = resolveFlag(pilot, other.vin, null, { at: '2026-10-01T09:30:00.000Z', how: 'manual' }); // sent closed by the 10:00 sync
  pilot = resolveFlag(pilot, sold.vin, null, { at: '2026-10-01T11:00:00.000Z', how: 'manual' }); // Taken down after it
  const syncState = { version: 1, since: '2026-10-01T10:00:00.000Z', localSince: '2026-10-01T10:00:00.000Z', known: [] }; // localSince: this machine's clock when that sync began
  const p = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, [k.pilot]: pilot, [k.sync]: syncState } });
  await p.tab('pilot');
  await p.click('pilotClear');
  await p.click('pilotClear');
  assert.equal(p.status(), "The numbers for this website were cleared. The to-do item still open stays until it is done. The to-do item closed since the last sync stays until the next sync sends it to your dealership's account.");
  assert.deepEqual(p.local[k.pilot].flags.map((f) => [f.vin, f.doneAt || null]), [[sold.vin, '2026-10-01T11:00:00.000Z'], [third.vin, null]], 'the Taken down waits for the sync; the item the 10:00 sync sent closed goes');
  assert.deepEqual(p.local[k.sync], syncState, 'the sync state is only read');

  // no sync state (never synced here, or signed out): closed items go as before
  const q = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, [k.pilot]: pilot } });
  await q.click('pilotClear');
  await q.click('pilotClear');
  assert.equal(q.status(), 'The numbers for this website were cleared. The to-do item still open stays until it is done.');
  assert.deepEqual(q.local[k.pilot].flags.map((f) => f.vin), [third.vin]);
});

// Settings belong to a dealership's website (CLAUDE.md: the dealership's
// fields travel only to the website the profile was saved on). Opened on a
// tab that is not one (Facebook, a new tab), the popup knows no website: its
// Settings offer no Save, and nothing it does writes the profile or a key
// with no website in it.
test('on a Facebook tab or a new tab Settings has no Save, and nothing writes the profile or a settings key without a website', async () => {
  for (const tabUrl of ['https://www.facebook.com/marketplace/create/vehicle', 'chrome://newtab/']) {
    const p = await loadPopup({ tabUrl, sync: { [PROFILE_KEY]: structuredClone(PROFILE) } });
    await p.tab('settings');
    const html = p.panel();
    assert.match(html, /id="settingsNeedSite">Settings are kept for each dealership website\. Open your dealership's website in this tab to see or change them\./, tabUrl);
    assert.doesNotMatch(html, /type="submit"/, `${tabUrl}: no Save settings`);
    assert.doesNotMatch(html, /name="dealerName"|name="priceNote"|name="dailyCap"/, `${tabUrl}: no dealership fields to fill in`);
    assert.match(html, /data-action="forgetProfile"/, `${tabUrl}: the profile can still be forgotten`);
    assert.match(html, /data-action="reportProblem"/, `${tabUrl}: and a problem reported`);

    // a submit anyway (Enter in a box) saves nothing
    const values = { salespersonName: 'Someone', dealerName: 'Another Dealer', priceNote: 'Price includes the $499 doc fee.', dailyCap: '4' };
    const before = globalThis.FormData;
    globalThis.FormData = class { get(name) { return values[name] ?? null; } getAll() { return []; } has(name) { return name in values; } };
    try {
      await p.el('panel').listeners.submit({ target: { id: 'settings', querySelector: () => null }, preventDefault() {} });
    } finally {
      globalThis.FormData = before;
    }
    assert.deepEqual(Object.keys(p.local).filter((key) => /^settings:/.test(key)), [], `${tabUrl}: no settings key was written`);
    assert.deepEqual(p.sync[PROFILE_KEY], PROFILE, `${tabUrl}: the synced profile is untouched`);
    assert.match(p.status(), /Open your dealership's website/);
  }
});

// "Forget my synced profile" says only saving Settings (or finishing set-up)
// brings the profile back, and so does the privacy policy: a scan, the
// automatic-rescan permission or a sign-in must not put it back in Chrome sync.
test('after Forget my synced profile, a Rescan, Allow automatic rescans or a sign-in leaves it forgotten; only Save settings re-creates it', async () => {
  const settings = { ...structuredClone(PROFILE), ...MY_STORE };
  const p = await loadPopup({ local: { [k.settings]: settings }, sync: { [PROFILE_KEY]: structuredClone(PROFILE) }, granted: false });
  await p.scan();
  assert.equal(p.status(), '', 'the scan went through');
  await p.click('forgetProfile');
  assert.match(p.status(), /^Your synced profile was removed from Chrome's sync storage\. The settings on this computer are unchanged; only saving Settings or finishing set-up re-creates the profile\.$/);
  assert.equal(p.sync[PROFILE_KEY], undefined);

  await p.scan();
  assert.equal(p.status(), '', 'the rescan went through');
  assert.equal(p.sync[PROFILE_KEY], undefined, 'a rescan does not re-create it');

  globalThis.chrome.permissions.request = async () => true;
  await p.click('allowRescans');
  assert.match(p.status(), /Automatic rescans are on/);
  assert.equal(p.local[k.settings].autoRescan, true, 'the setting was saved for this website');
  assert.equal(p.sync[PROFILE_KEY], undefined, 'allowing rescans does not re-create it');

  // a sign-in points the rewrite address at the account and saves the website's settings
  const boxes = { accountEmail: 'sam@example.test', accountCode: '123456' };
  const query = globalThis.document.querySelector;
  const fetchBefore = globalThis.fetch;
  globalThis.document.querySelector = (sel) => { const m = /\[name="(\w+)"\]/.exec(sel); return m && m[1] in boxes ? { value: boxes[m[1]] } : null; };
  globalThis.fetch = async (url) => (String(url).endsWith('/auth/v1/verify')
    ? { ok: true, status: 200, json: async () => ({ access_token: 'a.e30.c', refresh_token: 'r', expires_in: 3600, user: { id: 'u1', email: boxes.accountEmail } }) }
    : { ok: false, status: 404, json: async () => ({}) });
  try {
    await p.click('accountSignIn');
  } finally {
    globalThis.document.querySelector = query;
    globalThis.fetch = fetchBefore;
  }
  assert.match(p.status(), /Synced|Sync failed|Signed in/, 'the sign-in went through');
  assert.equal(p.sync[PROFILE_KEY], undefined, 'a sign-in does not re-create it');

  // Save settings does, as the status line and the privacy policy say
  await p.tab('settings');
  const values = { salespersonName: 'Sam', salespersonTitle: 'sales manager', dailyCap: '5' };
  const before = globalThis.FormData;
  globalThis.FormData = class { get(name) { return values[name] ?? null; } getAll() { return []; } has(name) { return name in values; } };
  try {
    await p.el('panel').listeners.submit({ target: { id: 'settings', querySelector: () => null }, preventDefault() {} });
  } finally {
    globalThis.FormData = before;
  }
  assert.equal(p.sync[PROFILE_KEY].salesperson.name, 'Sam');
  assert.equal(p.sync[PROFILE_KEY].origin, POPUP_ORIGIN);
});

// A post the sync function would not put on the dealership's list (a
// colleague already had the car up, or the post's time was ahead of the
// server's clock) is named where the salesperson looks: a banner on To do,
// the car in My listings, and a count in Settings' sync line.
test('a post the last sync could not share is named on To do, on the car in My listings and in Settings', async () => {
  const ram = vehicle('usedNormal');
  const jeep = vehicle('certified');
  const shared = vehicle('usedZeroMiles');
  const at = (min) => new Date(Date.UTC(2026, 9, 1, 9, min)).toISOString();
  const posted = {
    [ram.vin]: { name: ram.name, price: ram.price, postedAt: at(30) },
    [jeep.vin]: { name: jeep.name, price: jeep.price, postedAt: at(50) },
    [shared.vin]: { name: shared.name, price: shared.price, postedAt: at(5) },
  };
  const syncState = { version: 1, since: at(40), known: [], dealershipName: 'Example Motors', role: 'salesperson', lastSyncAt: at(40), plan: null, postsToday: null,
    notShared: [{ vin: ram.vin, postedAt: at(30), reason: 'colleague', by: 'Pat' }, { vin: jeep.vin, postedAt: at(50), reason: 'clock' }] };
  const session = { accessToken: 'a.e30.c', refreshToken: 'r', expiresAt: Date.now() + 3600e3, user: { id: 'u1', email: 'sam@example.test' } };
  const p = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, [k.posted]: posted, [k.sync]: syncState, account: session } });
  await p.scan();
  assert.equal(p.status(), '', 'the scan went through');
  assert.match(p.panel(), /id="notSharedBanner">2 of your posts are not on your dealership's list: the last sync could not share them\. <b>My listings<\/b> says why\./);

  await p.tab('mine');
  const items = p.panel().split('<li class="row');
  const itemOf = (car) => items.find((t) => t.includes(car.name)) || '';
  assert.match(itemOf(ram), /Not shared with your dealership: Pat already has this car listed, so your dealership's list and the manager view show theirs, not yours\./);
  assert.match(itemOf(jeep), /Not shared with your dealership: this post's time is ahead of the server's clock\. Check this computer's date and time, then sync again\./);
  assert.doesNotMatch(itemOf(shared), /Not shared/, 'a shared post says nothing');

  await p.tab('settings');
  assert.match(p.panel(), /id="syncStatus">Last sync [^<]* · 2 of your posts are not shared with your dealership \(My listings says why\)\. /);

  // taken down here since the last sync: no longer counted, in Settings as on To do
  await p.click('takenDown', { vin: ram.vin });
  assert.match(p.panel(), /id="syncStatus">Last sync [^<]* · 1 of your posts is not shared with your dealership \(My listings says why\)\. /);
  await p.tab('todo');
  assert.match(p.panel(), /id="notSharedBanner">One of your posts is not on your dealership's list/);

  // nothing refused: no banner
  const q = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, [k.posted]: posted, [k.sync]: { ...syncState, notShared: [] }, account: session } });
  await q.scan();
  assert.doesNotMatch(q.panel(), /notSharedBanner/);
  // a sync run elsewhere (the service worker, the side panel) that could not share a post: the open popup says so at once
  q.storageChanged({ [k.sync]: { newValue: { ...syncState } } });
  assert.match(q.panel(), /id="notSharedBanner">2 of your posts are not on your dealership's list/);
});

// A sync the account server turned away for coming too often (more than a
// dozen a minute) is tried again by the service worker a minute later
// (background.js planRetry, which records lastSyncRetry): Settings says so
// while it is still to come, and nothing about it once that time has passed.
test('Settings says a sync the server asked to wait is tried again on its own, only while that is still to come', async () => {
  const session = { accessToken: 'a.e30.c', refreshToken: 'r', expiresAt: Date.now() + 3600e3, user: { id: 'u1', email: 'sam@example.test' } };
  const syncState = { version: 1, since: '2026-10-01T09:00:00.000Z', known: [], dealershipName: 'Example Motors', role: 'salesperson', lastSyncAt: '2026-10-01T09:00:00.000Z', plan: null, postsToday: null };
  const entry = (retry) => ({ name: 'Example Motors', lastSync: '2026-10-01T09:00:00.000Z', lastSyncAttempt: '2026-10-01T09:05:00.000Z', lastSyncError: 'too many syncs; try again in a minute', lastSyncRetry: retry });
  const soon = new Date(Date.now() + 50 * 1000).toISOString();
  const p = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, [k.sync]: syncState, account: session, sites: { [POPUP_ORIGIN]: entry(soon) } } });
  await p.tab('settings');
  assert.match(p.panel(), /id="syncStatus">Last sync [^<]* · the last attempt failed: too many syncs; try again in a minute; Lot Current tries again on its own at [^<.]+\. /);

  const past = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, [k.sync]: syncState, account: session, sites: { [POPUP_ORIGIN]: entry(new Date(Date.now() - 60 * 1000).toISOString()) } } });
  await past.tab('settings');
  assert.match(past.panel(), /id="syncStatus">Last sync [^<]* · the last attempt failed: too many syncs; try again in a minute\. /);
  assert.doesNotMatch(past.panel(), /tries again on its own/, 'a retry whose time has passed is not promised');
});

// Settings' Save with "Price to post" set to `basis` (the form as the popup
// reads it), returning the storage keys in the order they were written.
async function saveBasis(p, basis) {
  await p.tab('settings');
  const values = { salespersonName: 'Sam', dailyCap: '10', basis };
  const before = globalThis.FormData;
  globalThis.FormData = class { get(name) { return values[name] ?? null; } getAll(name) { return name === 'store' ? MY_STORE.myStores : []; } has(name) { return name in values; } };
  const writes = [];
  const set = globalThis.chrome.storage.local.set;
  globalThis.chrome.storage.local.set = async (obj) => { writes.push(...Object.keys(obj)); return set(obj); };
  try {
    await p.el('panel').listeners.submit({ target: { id: 'settings', querySelector: () => null }, preventDefault() {} });
  } finally {
    globalThis.FormData = before;
    globalThis.chrome.storage.local.set = set;
  }
  return writes;
}

// Changing "Price to post" applies to new posts. A listing already posted
// keeps the price it was posted at and is still checked against the website
// on that price, so the change is never a price edit to make: the posting
// rules every salesperson ticks (legal/posting-rules.md) say to change a
// listing's price only when the website changes, with no made-up drops and
// no raising a price to lower it later. Switching to the lower second price
// and back therefore lists nothing on To do, either way, and counts nothing.
test('a change of Price to post is for new posts: a posted listing keeps its price, and switching there and back asks for no price edit', async () => {
  const ram = vehicle('usedNormal'); // $27,163, or $26,673 before the fee
  const posted = { [ram.vin]: { name: ram.name, price: ram.price, postedAt: new Date().toISOString() } }; // recorded before entries carried a basis
  const p = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, [k.posted]: posted } });
  await p.scan();
  assert.doesNotMatch(p.panel(), /Update price/, 'posted at the website price: nothing to do');
  assert.equal(p.local[k.posted][ram.vin].basis, 'website', 'the scan records the price the listing is on (scanRunner.js keepSeenBasis)');
  p.local[k.posted] = structuredClone(posted); // brought back without one, as a sync from another computer would

  // the lower second price: the listing is stamped with the basis in force
  // until now before the new one is saved, so a background rescan between
  // the two writes never reads it under the new one
  const writes = await saveBasis(p, 'beforeFees');
  assert.equal(p.local[k.settings].basis, 'beforeFees');
  assert.deepEqual([p.local[k.posted][ram.vin].price, p.local[k.posted][ram.vin].basis], [27163, 'website'], 'the listing keeps its price, recorded as posted at the main price');
  assert.ok(writes.includes(k.posted) && writes.indexOf(k.posted) < writes.indexOf(k.settings), `the listing is stamped before the new basis is saved (writes: ${writes.join(', ')})`);
  assert.equal(p.el('saved').textContent, 'Saved. Click Rescan website to apply. Your listings keep the price they were posted at; the new price setting is for new posts.');

  await p.scan();
  assert.doesNotMatch(p.panel(), /Update price|Price to post changed/, 'no price edit: the website did not change');
  assert.deepEqual((p.local[k.pilot]?.flags || []).filter((f) => f.kind === 'price'), [], 'and nothing counted as a price change');
  await p.tab('mine');
  assert.match(p.panel(), /<span class="pill good">Matches the website<\/span>/);
  assert.match(p.panel(), /posted at the website&#39;s main price; your price setting now applies to new posts/);
  assert.doesNotMatch(p.panel(), /data-action="priceUpdated"/, 'no Updated button: there is nothing to update');

  // and back to the main price: no raise either
  await saveBasis(p, 'website');
  assert.equal(p.local[k.settings].basis, 'website');
  await p.scan();
  assert.doesNotMatch(p.panel(), /Update price|Price to post changed/, 'switching back asks for no edit either');
  assert.deepEqual((p.local[k.pilot]?.flags || []).filter((f) => f.kind === 'price'), []);
  assert.equal(p.local[k.posted][ram.vin].price, 27163, 'the listing never moved');
});

// A To do price item listed before "Price to post" changed is the website's
// own price change, taken on the price the listing was posted at. Acted on
// after the change, the listing keeps that basis, so the next rescan finds
// nothing left to do and the numbers count the one real price change once.
test('a price item listed before Price to post changed is the website\'s change on the listing\'s own price, and nothing is left after it', async () => {
  const ram = vehicle('usedNormal'); // $27,163 on the website, or $26,673 before the fee
  const posted = { [ram.vin]: { name: ram.name, price: 27663, postedAt: new Date().toISOString() } }; // listed at the website's earlier $27,663, before entries carried a basis
  const p = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, [k.posted]: posted } });
  await p.scan();
  const flagged = () => (p.local[k.pilot]?.flags || []).filter((f) => f.kind === 'price' && f.vin === ram.vin).length;
  assert.equal(flagged(), 1, 'the website really dropped $500: one price change');
  const button = new RegExp(`data-action="priceUpdated" data-vin="${ram.vin}" data-price="27163"`);
  assert.match(p.panel(), button);

  // Price to post changes before the person gets to the item; To do still shows it until the next rescan
  await saveBasis(p, 'beforeFees');
  assert.equal(p.local[k.posted][ram.vin].basis, 'website', 'stamped with the basis the item\'s price was taken at');
  await p.tab('todo');
  assert.match(p.panel(), button, 'the item still offers the website\'s main price');

  // the person set the listing to the item's $27,163 and clicks Updated on it
  await p.click('priceUpdated', { vin: ram.vin, price: '27163' });
  assert.deepEqual([p.local[k.posted][ram.vin].price, p.local[k.posted][ram.vin].basis], [27163, 'website']);

  await p.scan();
  assert.doesNotMatch(p.panel(), /Update price|Price to post changed/, 'nothing left to do');
  assert.equal(flagged(), 1, 'and the numbers count only the one real price change');
});

// This computer's last scan of the website, as a scan saved it, moved back in
// time to `takenAt` and showing the Ram at `price`, or `lower` before the fee.
async function lastScanOf(ram, settings, takenAt, price, lower) {
  const first = await loadPopup({ local: { [k.settings]: settings } });
  await first.scan();
  assert.equal(first.status(), '', 'the scan went through');
  const last = structuredClone(first.local[k.snapshot]);
  last.takenAt = takenAt;
  Object.assign(last.vehicles[ram.vin], { price, priceBeforeFees: lower });
  return last;
}

// My listings reads the price basis of a listing that has none (posted with
// an older version on another computer, brought here by sync) as the rescan
// does: only off a scan taken once the listing had its price (src/rescan.js
// scanCar). The last scan here is from before: after the website's $500 cut,
// the listing's price is on neither of that scan's prices, and the setting
// (the lower second price) would name that scan's old lower price as the
// website's and offer Updated to record it, a raise the website never made.
test('My listings names no website price for a listing with no basis priced after the last scan, and offers no Updated; the next scan compares it', async () => {
  const ram = vehicle('usedNormal'); // $27,163 on the website, or $26,673 before the fee
  const settings = { ...MY_STORE, basis: 'beforeFees' };
  const last = await lastScanOf(ram, settings, '2026-10-01T09:00:00.000Z', 27663, 27173); // before the cut
  const posted = { [ram.vin]: { name: ram.name, price: 27163, postedAt: '2026-10-02T09:00:00.000Z' } }; // at the new main price
  const p = await loadPopup({ local: { [k.settings]: settings, [k.snapshot]: last, [k.posted]: structuredClone(posted) } });
  await p.tab('mine');
  const mine = p.panel();
  assert.doesNotMatch(mine, /\$27,173|\$27,663/, 'no price of a scan from before the listing\'s price is named');
  assert.doesNotMatch(mine, /Website price changed|data-action="priceUpdated"/, 'and there is no Updated to record one');
  assert.doesNotMatch(mine, /posted at the/, 'nor a basis read off that scan');
  assert.match(mine, /<span class="pill ?">Price compared at the next scan<\/span>/);
  assert.match(mine, /Listed \$27,163/);
  assert.deepEqual(p.local[k.posted], posted, 'nothing recorded');

  // the next scan, the website as it is now: it reads the basis the listing is on, and My listings compares on it
  await p.scan();
  assert.equal(p.status(), '', 'the scan went through');
  assert.deepEqual([p.local[k.posted][ram.vin].price, p.local[k.posted][ram.vin].basis], [27163, 'website']);
  await p.tab('mine');
  assert.match(p.panel(), /<span class="pill good">Matches the website<\/span>/);
  assert.match(p.panel(), /posted at the website&#39;s main price; your price setting now applies to new posts/);
  assert.doesNotMatch(p.panel(), /data-action="priceUpdated"/);

  // a cut by exactly the gap between the two prices: the new main price is that older scan's lower one,
  // which would read as posted at the lower second price
  const gap = await lastScanOf(ram, { ...MY_STORE, basis: 'website' }, '2026-10-01T09:00:00.000Z', 27163, 26673);
  const cut = { [ram.vin]: { name: ram.name, price: 26673, postedAt: '2026-10-02T09:00:00.000Z' } };
  const q = await loadPopup({ local: { [k.settings]: { ...MY_STORE, basis: 'website' }, [k.snapshot]: gap, [k.posted]: structuredClone(cut) } });
  await q.tab('mine');
  assert.doesNotMatch(q.panel(), /posted at the|\$27,163|data-action="priceUpdated"/, 'no basis and no price read off a scan from before');
  assert.match(q.panel(), /<span class="pill ?">Price compared at the next scan<\/span>/);
  assert.deepEqual(q.local[k.posted], cut);
});

// What a last scan from before the listing's price says about the car itself
// (sale pending, needs a look, not pre-owned) still shows, but that scan's
// price is the website as it was then: on the lower second price, its
// pre-cut $27,173 would read as the website's price now.
test('My listings shows a sale pending, needs a look or not pre-owned from a scan taken before the listing\'s price without naming that scan\'s price', async () => {
  const ram = vehicle('usedNormal'); // $27,163 on the website, or $26,673 before the fee
  const settings = { ...MY_STORE, basis: 'beforeFees' };
  const posted = { [ram.vin]: { name: ram.name, price: 27163, postedAt: '2026-10-02T09:00:00.000Z' } }; // at the new main price, after the cut
  for (const [patch, text] of [[{ status: 'pend-sale' }, 'Sale pending on the website'], [{ decision: 'review' }, 'Needs a look (see To do)'], [{ decision: 'skip' }, 'Not pre-owned on the website']]) {
    const last = await lastScanOf(ram, settings, '2026-10-01T09:00:00.000Z', 27663, 27173); // before the cut
    Object.assign(last.vehicles[ram.vin], patch);
    const p = await loadPopup({ local: { [k.settings]: settings, [k.snapshot]: last, [k.posted]: structuredClone(posted) } });
    await p.tab('mine');
    const mine = p.panel();
    assert.ok(mine.includes(`">${text}</span>`), `${text} shows`);
    assert.doesNotMatch(mine, /Website \$|Website —|\$27,173|\$27,663/, `${text}: no price of a scan from before the listing's price`);
    assert.match(mine, /Listed \$27,163/);
    assert.doesNotMatch(mine, /data-action="priceUpdated"/);
    assert.deepEqual(p.local[k.posted], posted, 'nothing recorded');
  }
  // a scan taken since the listing's price names the website's price beside it, as before
  const later = await lastScanOf(ram, settings, '2026-10-03T09:00:00.000Z', 26663, 26173);
  later.vehicles[ram.vin].status = 'pend-sale';
  const q = await loadPopup({ local: { [k.settings]: settings, [k.snapshot]: later, [k.posted]: structuredClone(posted) } });
  await q.tab('mine');
  assert.match(q.panel(), /Sale pending on the website/);
  assert.match(q.panel(), /Listed \$27,163<br>Website \$26,173/);
});

// A draft filled before the last scan and published since: Mark posted
// records the draft's price, and the scan, taken after the draft got that
// price, shows the website's price now. To do lists the change at once
// (src/drafts.js draftPriceUpdate), and My listings shows it too, with
// Updated at the website's price, not "Price compared at the next scan".
test('My listings shows the price change of a listing published from a draft filled before the last scan, as To do does', async () => {
  const ram = vehicle('usedNormal'); // $27,163 on the website
  const savedAt = new Date(Date.now() - 86400e3).toISOString(); // filled yesterday, when the website asked $27,663
  const drafts = { [ram.vin]: { name: ram.name, savedAt, price: 27663, basis: 'website' } };
  const p = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, [k.drafts]: drafts } });
  await p.scan();
  assert.equal(p.status(), '', 'the scan went through');
  await p.tab('ready');
  assert.match(p.panel(), /<span class="pill bad" title="Change the price on the draft to \$27,163 before you publish it\.[^"]*">Draft on Facebook at \$27,663: the website now shows \$27,163<\/span>/, 'the pill compares the draft with a scan taken since it was filled');
  await p.click('markToday', { vin: ram.vin }); // published today
  assert.match(p.status(), /^Recorded at \$27,663, the price the draft was filled with\. The website now shows \$27,163: update the price on the listing \(To do, Update price\)\.$/);
  await p.tab('todo');
  assert.match(p.panel(), new RegExp(`data-action="priceUpdated" data-vin="${ram.vin}" data-price="27163"`));
  await p.tab('mine');
  assert.match(p.panel(), /<span class="pill warn">Website price changed<\/span>/);
  assert.match(p.panel(), /Listed \$27,663<br>Website \$27,163/);
  assert.match(p.panel(), new RegExp(`data-action="priceUpdated" data-vin="${ram.vin}" data-price="27163"`), 'Updated at the website\'s price');
  // the listing keeps when the draft got its price, and the time it was marked posted
  const entry = p.local[k.posted][ram.vin];
  assert.deepEqual([entry.price, entry.basis, entry.draftSavedAt], [27663, 'website', savedAt]);
  assert.ok(Date.parse(entry.postedAt) > Date.parse(p.local[k.snapshot].takenAt), 'marked after the scan');
  await p.click('priceUpdated', { vin: ram.vin, price: '27163' });
  assert.equal(p.local[k.posted][ram.vin].price, 27163, 'Updated records the website\'s price');
  await p.tab('mine');
  assert.match(p.panel(), /<span class="pill good">Matches the website<\/span>/);
  assert.doesNotMatch(p.panel(), /data-action="priceUpdated"/);
});

// A draft filled after the last scan, at the website's price then: that scan
// shows the website as it was before the draft got its price, so its price is
// not the website's now. The Ready pill, Mark posted's status line and To do
// compare the draft with that scan no more than My listings does (src/drafts.js
// draftScanCar, src/rescan.js scanCar): until the next scan none of them names
// that scan's price, and To do offers no Updated to record it (rule 4).
test('a draft filled after the last scan is not compared with that scan\'s older price: the pill, Mark posted, To do and My listings wait for the next scan', async () => {
  const ram = vehicle('usedNormal'); // $27,163 on the website now
  const settings = { ...MY_STORE, basis: 'website' };
  const first = await loadPopup({ local: { [k.settings]: settings } });
  await first.scan();
  assert.equal(first.status(), '', 'the scan went through');
  // that scan, two days ago, before the website's $500 cut
  const last = structuredClone(first.local[k.snapshot]);
  last.takenAt = new Date(Date.now() - 2 * 86400e3).toISOString();
  Object.assign(last.vehicles[ram.vin], { price: 27663, priceBeforeFees: 27173 });
  const savedAt = new Date(Date.now() - 3600e3).toISOString(); // filled an hour ago, at the website's price then
  const drafts = { [ram.vin]: { name: ram.name, savedAt, price: 27163, basis: 'website' } };
  const p = await loadPopup({ local: { [k.settings]: settings, [k.snapshot]: last, [k.diff]: structuredClone(first.local[k.diff]), [k.drafts]: drafts } });
  await p.tab('ready');
  assert.match(p.panel(), /<span class="pill warn" title="Saved as a draft on Facebook: publish it there, then mark it posted\.">Draft on Facebook at \$27,163<\/span>/);
  assert.doesNotMatch(p.panel(), /the website now shows|Change the price on the draft/, 'the pill names no price of a scan from before the draft (the row\'s price column is that scan\'s, as for every car)');

  await p.click('markToday', { vin: ram.vin }); // published today
  assert.doesNotMatch(p.status(), /website now shows|\$27,663/, 'nor does Mark posted');
  const entry = p.local[k.posted][ram.vin];
  assert.deepEqual([entry.price, entry.basis, entry.draftSavedAt], [27163, 'website', savedAt], 'recorded at the draft\'s price');
  await p.tab('todo');
  assert.doesNotMatch(p.panel(), new RegExp(`data-action="priceUpdated" data-vin="${ram.vin}"|\\$27,663`), 'To do lists no price to update, so its Updated records none');
  assert.equal((p.local[k.diff].priceUpdates || []).filter((u) => u.vin === ram.vin).length, 0);
  await p.tab('mine');
  assert.match(p.panel(), /<span class="pill ?">Price compared at the next scan<\/span>/);
  assert.match(p.panel(), /Listed \$27,163/);
  assert.doesNotMatch(p.panel(), /data-action="priceUpdated"|\$27,663/);
  assert.deepEqual(p.local[k.posted][ram.vin], entry, 'nothing else recorded');

  // the next scan shows the website as it is now: the listing matches it, and there is nothing to update
  await p.scan();
  assert.equal(p.status(), '', 'the scan went through');
  assert.doesNotMatch(p.panel(), new RegExp(`data-action="priceUpdated" data-vin="${ram.vin}"`));
  await p.tab('mine');
  assert.match(p.panel(), /<span class="pill good">Matches the website<\/span>/);
  assert.equal(p.local[k.posted][ram.vin].price, 27163);
});

// A listing with no basis whose price is older than the last scan is read as
// before: the basis off that scan where only one of its prices is the
// listing's, else the setting, and Updated records the website's price on it.
test('My listings still reads the basis of a listing with no basis off a scan taken since its price, and Updated records the website price on it', async () => {
  const ram = vehicle('usedNormal'); // $27,163 on the website, or $26,673 before the fee
  const settings = { ...MY_STORE, basis: 'website' };
  const last = await lastScanOf(ram, settings, '2026-10-03T09:00:00.000Z', 27163, 26673);
  const lower = { [ram.vin]: { name: ram.name, price: 26673, postedAt: '2026-10-02T09:00:00.000Z' } }; // posted at the lower second price before that scan
  const p = await loadPopup({ local: { [k.settings]: settings, [k.snapshot]: last, [k.posted]: lower } });
  await p.tab('mine');
  assert.match(p.panel(), /<span class="pill good">Matches the website<\/span>/);
  assert.match(p.panel(), /posted at the lower second price; your price setting now applies to new posts/, 'the basis read off the scan taken since');

  // posted at the website's earlier $27,663 before that scan: on neither of its prices, so compared on the setting
  const earlier = { [ram.vin]: { name: ram.name, price: 27663, postedAt: '2026-10-02T09:00:00.000Z' } };
  const q = await loadPopup({ local: { [k.settings]: settings, [k.snapshot]: last, [k.posted]: earlier } });
  await q.tab('mine');
  assert.match(q.panel(), /<span class="pill warn">Website price changed<\/span>/);
  assert.match(q.panel(), /Website \$27,163/);
  assert.match(q.panel(), new RegExp(`data-action="priceUpdated" data-vin="${ram.vin}" data-price="27163"`));
  await q.click('priceUpdated', { vin: ram.vin, price: '27163' });
  assert.equal(q.local[k.posted][ram.vin].price, 27163, 'Updated records the website\'s price');
  assert.ok(Date.parse(q.local[k.posted][ram.vin].updatedAt) > Date.parse(last.takenAt));
  await q.tab('mine');
  assert.match(q.panel(), /<span class="pill good">Matches the website<\/span>/, 'and the listing then matches it');
  assert.doesNotMatch(q.panel(), /data-action="priceUpdated"/);
});

// A listing posted here after the last scan, at the price the side panel read
// on the website when it filled the form, after the website changed it: the
// last scan's price is from before, so it is not the website's price now,
// and Updated there would record a price the listing was never asked to take
// (here a raise back to the price before the cut).
test('My listings does not ask a listing posted after the last scan to take that scan\'s older price', async () => {
  const ram = vehicle('usedNormal'); // $27,163 on the website, or $26,673 before the fee
  const settings = { ...MY_STORE, basis: 'website' };
  const last = await lastScanOf(ram, settings, '2026-10-01T09:00:00.000Z', 27663, 27173); // before the cut
  const posted = { [ram.vin]: { name: ram.name, price: 27163, basis: 'website', postedAt: '2026-10-02T09:00:00.000Z' } };
  const p = await loadPopup({ local: { [k.settings]: settings, [k.snapshot]: last, [k.posted]: structuredClone(posted) } });
  await p.tab('mine');
  assert.doesNotMatch(p.panel(), /\$27,663|Website price changed|data-action="priceUpdated"/);
  assert.match(p.panel(), /<span class="pill ?">Price compared at the next scan<\/span>/);
  assert.deepEqual(p.local[k.posted], posted, 'nothing recorded');

  // the same listing, posted at the price the last scan showed: it matches, as before
  const same = { [ram.vin]: { ...posted[ram.vin], price: 27663 } };
  const q = await loadPopup({ local: { [k.settings]: settings, [k.snapshot]: last, [k.posted]: same } });
  await q.tab('mine');
  assert.match(q.panel(), /<span class="pill good">Matches the website<\/span>/);
});

// Settings says before the save that a change is for new posts, with how
// many listings the person has here; only where the website shows a lower
// second price, since elsewhere there is no other price to choose.
test('Settings says a change of Price to post is for new posts, only where the website shows a lower second price', async () => {
  // the lower second price is the one the website's display shows beside the main one (adapters/dealerInspireNormalize.js displayedSecondPrice): none here
  const noSecond = (name) => (fixtures[name]?.extra_fields?.lightning?.pricing?.low ? { extra_fields: { lightning: { pricing: { high: null } } } } : {});
  const records = Object.entries(fixtures).filter(([name]) => name !== '_about').map(([name]) => raw(name, { pricing: { price: 0, internet_price: 0 }, ...noSecond(name) }));
  const ram = vehicle('usedNormal');
  const posted = { [ram.vin]: { name: ram.name, price: ram.price, postedAt: new Date().toISOString(), basis: 'website' } };
  const p = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, [k.posted]: posted }, records });
  await p.scan();
  assert.equal(p.status(), '', 'the scan went through');
  await p.tab('settings');
  assert.doesNotMatch(p.panel(), /value="beforeFees"/, 'no lower price to choose');
  assert.doesNotMatch(p.panel(), /basisNote/, 'so nothing to say about a change');

  const q = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, [k.posted]: posted } });
  await q.scan();
  await q.tab('settings');
  assert.match(q.panel(), /value="beforeFees"/);
  assert.match(q.panel(), /id="basisNote">You have one posted listing on this website\. A change here is for new posts: that listing keeps the price it was posted at, and rescans keep checking it against the website on that price\.<\/p>/, 'where there is one, the note is beside it');
  assert.doesNotMatch(q.panel(), /Facebook may tell people|Price to post changed/, 'never a price edit to make');

  const none = await loadPopup({ local: { [k.settings]: { ...MY_STORE } } });
  await none.scan();
  await none.tab('settings');
  assert.doesNotMatch(none.panel(), /basisNote/, 'no listings here: nothing to say');
});

// Sign out from any tab (here Marketplace, which names no dealership
// website) forgets the sync state of every website on this computer, so the
// next account to sign in never sees the last one's dealership, role or plan
// on another website, and the cap never counts its posts today there.
test('Sign out from a Facebook tab forgets every website\'s sync state and keeps the posted lists', async () => {
  const other = siteKeys('https://www.example-sister-store.test');
  const session = { accessToken: 'a.e30.c', refreshToken: 'r', expiresAt: Date.now() + 3600e3, user: { id: 'u1', email: 'sam@example.test' } };
  const state = { version: 1, since: '2026-10-01T09:00:00.000Z', known: [], dealershipName: 'Example Motors', role: 'manager', lastSyncAt: '2026-10-01T09:00:00.000Z', plan: { state: 'lapsed' }, postsToday: 4 };
  const posted = { [sampleVin(1)]: { name: 'A car', price: 10000, postedAt: '2026-10-01T08:00:00.000Z' } };
  const p = await loadPopup({ tabUrl: 'https://www.facebook.com/marketplace/you/selling', local: { account: session, [k.sync]: state, [other.sync]: state, [k.posted]: posted, [other.posted]: posted } });
  const calls = [];
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 204, json: async () => ({}) }; };
  try {
    await p.click('accountSignOut');
  } finally {
    globalThis.fetch = fetchBefore;
  }
  assert.match(p.status(), /^Signed out\./);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/auth\/v1\/logout\?scope=local$/, 'this browser\'s session only');
  assert.equal(p.local.account, undefined);
  assert.equal(p.local[k.sync], undefined);
  assert.equal(p.local[other.sync], undefined, 'the website not open goes too');
  assert.deepEqual(p.local[k.posted], posted, 'the posted lists stay on this computer');
  assert.deepEqual(p.local[other.posted], posted);
});

// Settings says Lot Current syncs after every rescan and after each post,
// take-down or price update recorded: the popup's own Rescan, Mark posted,
// unmarking Posted ✓, Taken down and Updated each ask the worker to sync
// while the person is signed in (the worker runs one more sync when one is
// already out, test/syncAfterChange.test.js), and none does while signed out.
test('signed in, the popup\'s Rescan, Mark posted, unmarking, Taken down and Updated each ask the worker to sync; signed out, none does', async () => {
  const ram = vehicle('usedNormal');
  const session = { accessToken: 'a.e30.c', refreshToken: 'r', expiresAt: Date.now() + 3600e3, user: { id: 'u1', email: 'sam@example.test' } };
  const until = async (check) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); };
  const run = async (local, { expect = true } = {}) => {
    const p = await loadPopup({ local });
    const sent = [];
    globalThis.chrome.runtime.sendMessage = async (msg) => { sent.push(msg); return {}; };
    const syncs = () => sent.filter((m) => m.type === 'syncNow');
    const steps = [];
    const step = async (name, act, n) => {
      await act();
      await until(() => syncs().length >= (expect ? n : 0)); // the pilot note is written first, without holding up the redraw
      steps.push([name, syncs().length]);
    };
    await step('rescan', () => p.scan(), 1);
    assert.equal(p.status(), '', 'the scan went through');
    // Mark posted asks when the listing went up (src/cap.js askWhenListed): the answer records it
    const markToday = async () => { await p.click('post', { vin: ram.vin }); await p.click('markToday', { vin: ram.vin }); };
    await step('mark posted', markToday, 2);
    assert.ok(p.local[k.posted][ram.vin], 'marked posted');
    await step('updated', () => p.click('priceUpdated', { vin: ram.vin, price: String(ram.price - 500) }), 3);
    assert.equal(p.local[k.posted][ram.vin].price, ram.price - 500);
    await step('taken down', () => p.click('takenDown', { vin: ram.vin }), 4);
    assert.equal(p.local[k.posted][ram.vin], undefined, 'taken down');
    // marked again: today's log has the car, so nothing is asked (src/cap.js askWhenListed)
    await p.click('post', { vin: ram.vin });
    assert.ok(p.local[k.posted][ram.vin], 'marked posted again');
    await step('unmarked', () => p.click('unpost', { vin: ram.vin }), 6);
    await new Promise((r) => setTimeout(r, 30)); // nothing more comes later
    return { steps, syncs: syncs() };
  };

  const signedIn = await run({ [k.settings]: { ...MY_STORE }, account: session });
  assert.deepEqual(signedIn.steps, [['rescan', 1], ['mark posted', 2], ['updated', 3], ['taken down', 4], ['unmarked', 6]]);
  assert.ok(signedIn.syncs.every((m) => m.origin === POPUP_ORIGIN), 'each for the website open');

  const signedOut = await run({ [k.settings]: { ...MY_STORE } }, { expect: false });
  assert.deepEqual(signedOut.syncs, [], 'signed out: nothing to sync with');
});

// Taken down and Updated change the posted list, close the item's flag in
// the pilot numbers and take the item off To do. A flag left open after the
// posted list changed would be lost at the next sync: the sync function files
// no item for an open flag the listing already shows, and mergeFlags drops
// that flag, so the item would be in neither the numbers nor the manager
// view. So the flag's write is awaited: when it fails (storage full) the
// reason is shown, the item stays on To do with nothing synced, and the same
// click closes it once there is room. Unmarking Posted ✓ says so too, and
// still syncs: the car is unmarked either way.
test('Taken down or Updated whose to-do flag cannot be saved says why and leaves the item on To do, and the same click closes it once there is room', async () => {
  const session = { accessToken: 'a.e30.c', refreshToken: 'r', expiresAt: Date.now() + 3600e3, user: { id: 'u1', email: 'sam@example.test' } };
  const sold = vehicle('usedNormal');
  const repriced = vehicle('certified');
  const records = Object.entries(fixtures).filter(([key]) => key !== '_about' && key !== 'usedNormal').map(([, r]) => r); // the sold car is gone from the website
  const postedAt = new Date(Date.now() - 3 * 86400e3).toISOString();
  const posted = { [sold.vin]: { name: sold.name, price: sold.price, postedAt }, [repriced.vin]: { name: repriced.name, price: repriced.price + 500, postedAt } };
  const until = async (check) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); };
  const p = await loadPopup({ records, local: { [k.settings]: { ...MY_STORE }, [k.posted]: posted, account: session } });
  await p.scan();
  assert.equal(p.status(), '', 'the scan went through');
  const flag = (vin, kind) => (p.local[k.pilot]?.flags || []).find((f) => f.vin === vin && f.kind === kind);
  assert.ok(flag(sold.vin, 'takeDown') && !flag(sold.vin, 'takeDown').doneAt, 'the sold car is flagged');
  assert.ok(flag(repriced.vin, 'price') && !flag(repriced.vin, 'price').doneAt, 'the price change is flagged');
  const sent = [];
  globalThis.chrome.runtime.sendMessage = async (msg) => { sent.push(msg); return {}; };
  const syncs = () => sent.filter((m) => m.type === 'syncNow').length;
  const onTodo = (list, vin) => (p.local[k.diff]?.[list] || []).some((x) => x.vin === vin);
  const set = globalThis.chrome.storage.local.set;
  let full = true;
  globalThis.chrome.storage.local.set = async (obj) => {
    if (full && k.pilot in obj) throw new Error('QUOTA_BYTES quota exceeded');
    return set(obj);
  };

  await p.click('takenDown', { vin: sold.vin });
  assert.equal(p.status(), STORAGE_FULL, 'Taken down says why');
  assert.equal(p.local[k.posted][sold.vin], undefined, 'the posted list changed first');
  assert.ok(onTodo('takeDown', sold.vin), 'the item stays on To do');
  assert.match(p.panel(), new RegExp(`data-action="takenDown" data-vin="${sold.vin}"`), 'with its Taken down button');
  assert.equal(flag(sold.vin, 'takeDown').doneAt, undefined, 'its flag is still open');

  const price = String(repriced.price);
  await p.click('priceUpdated', { vin: repriced.vin, price });
  assert.equal(p.status(), STORAGE_FULL, 'Updated says why');
  assert.equal(p.local[k.posted][repriced.vin].price, repriced.price);
  assert.ok(onTodo('priceUpdates', repriced.vin), 'the price item stays on To do');
  assert.equal(flag(repriced.vin, 'price').doneAt, undefined);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(syncs(), 0, 'nothing synced while a flag is open on a fixed listing');

  // room again: the same clicks close each item and sync
  full = false;
  await p.click('takenDown', { vin: sold.vin });
  assert.equal(flag(sold.vin, 'takeDown').how, 'manual', 'the take-down closes');
  assert.ok(!onTodo('takeDown', sold.vin), 'and leaves To do');
  await p.click('priceUpdated', { vin: repriced.vin, price });
  assert.equal(flag(repriced.vin, 'price').how, 'manual');
  assert.ok(!onTodo('priceUpdates', repriced.vin));
  await until(() => syncs() >= 2);
  assert.equal(syncs(), 2, 'one sync after each');

  // unmarking Posted ✓ with the numbers full: said, and the car is unmarked and synced all the same
  const other = vehicle('usedZeroMiles');
  await p.click('post', { vin: other.vin });
  await p.click('markToday', { vin: other.vin });
  assert.ok(p.local[k.posted][other.vin], 'marked posted');
  await until(() => syncs() >= 3);
  full = true;
  await p.click('unpost', { vin: other.vin });
  assert.equal(p.status(), STORAGE_FULL, 'unmarking says the numbers could not be saved');
  assert.equal(p.local[k.posted][other.vin], undefined, 'the car is unmarked');
  await until(() => syncs() >= 4);
  assert.equal(syncs(), 4, 'and colleagues are told it is free');
  globalThis.chrome.storage.local.set = set;
});

// A car whose form Lot Current filled today went up today at the earliest:
// Mark posted records it as one of today's posts without asking, so a
// "Before today" can't take it off the cap. Before, the question came for
// any car without a draft saved today.
test('Mark posted records a car whose form the side panel filled today as today\'s post, without asking', async () => {
  const car = vehicle('usedNormal');
  const now = new Date();
  const filled = notePostStep(beginPost(null, { vin: car.vin, name: car.name, salesperson: 'Sam', at: new Date(now.getTime() - 60e3).toISOString() }), car.vin, 'filledAt', now.toISOString());
  const cases = {
    // the panel was closed before "It's posted": the attempt on the Numbers tab
    'panel closed': { [k.pilot]: endPost(filled, car.vin, 'abandoned') },
    // marked here while the form is open: the post under way in the side panel
    'form open': { [k.flow]: { vin: car.vin, step: 'publish', readAt: now.toISOString(), fill: { filled: [{ key: 'price' }], partial: [], blocked: [] } } },
  };
  for (const [name, saved] of Object.entries(cases)) {
    const p = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, ...saved } });
    await p.scan();
    assert.equal(p.status(), '', 'the scan went through');
    await p.tab('ready');
    await p.click('post', { vin: car.vin });
    assert.doesNotMatch(p.panel(), /data-action="markBefore"/, `${name}: nothing is asked`);
    const entry = p.local[k.posted][car.vin];
    assert.ok(entry && entry.listedBefore === undefined, `${name}: recorded as posted today`);
    assert.deepEqual(p.local[k.postLog].map((e) => e.vin), [car.vin], `${name}: on today's log, so the cap counts it`);
    assert.match(p.status(), /^Recorded as posted today: Lot Current filled the form for .+ today or recorded it earlier today, so it counts toward today's posts\.$/);
  }
  // a car with no record of today is asked about, as before
  const q = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, [k.pilot]: notePostStep(beginPost(null, { vin: car.vin, at: '2026-09-01T09:00:00.000Z' }), car.vin, 'filledAt', '2026-09-01T09:01:00.000Z') } });
  await q.scan();
  await q.tab('ready');
  await q.click('post', { vin: car.vin });
  assert.match(q.panel(), /data-action="markBefore"/, 'filled on another day: the question is asked');
  assert.equal(q.local[k.posted], undefined, 'nothing recorded yet');
});

// Only a Marketplace listing's own address is saved as a listing link now
// (facebook/detectPost.js listingLink). A link saved before that rule (the
// Your listings page Facebook lands on after Publish, another page), or
// synced from a colleague's computer without it, showed as "Open listing"
// in My listings and opened the wrong page until the car was posted again.
test('My listings shows Open listing only for a Marketplace listing\'s own address, the test hook\'s included', async () => {
  const own = vehicle('usedZeroMiles');
  const theirs = vehicle('usedNormal');
  const at = new Date().toISOString();
  const colleague = { mine: false, userId: 'colleague-id', salesperson: 'Pat' };
  const listed = (ownUrl, theirUrl, extra = {}) => ({
    [own.vin]: { name: own.name, price: own.price, postedAt: at, listingUrl: ownUrl },
    [theirs.vin]: { name: theirs.name, price: theirs.price, postedAt: at, listingUrl: theirUrl, ...colleague },
    ...extra,
  });
  const mine = async (posted, local = {}) => {
    const p = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, [k.posted]: posted, ...local } });
    await p.scan();
    await p.tab('mine');
    return p.panel();
  };
  // saved before the rule: Your listings, another website, text that is no address
  for (const bad of ['https://www.facebook.com/marketplace/you/selling', 'https://www.facebook.com/marketplace/', 'https://listing.example.test/1', 'javascript:alert(1)', 'not a link']) {
    const html = await mine(listed(bad, bad));
    assert.doesNotMatch(html, /Open listing/, `no link for ${bad}`);
    assert.match(html, /Posted by Pat/, 'the colleague\'s listing is still shown');
  }
  // a listing's own address is linked; another spelling of the website opens the form's own
  const good = await mine(listed('https://www.facebook.com/marketplace/item/1001/', 'https://m.facebook.com/marketplace/item/2002/?ref=share'));
  assert.equal((good.match(/>Open listing</g) || []).length, 2);
  assert.match(good, /href="https:\/\/www\.facebook\.com\/marketplace\/item\/1001\/"/);
  assert.match(good, /href="https:\/\/www\.facebook\.com\/marketplace\/item\/2002\/"/);
  // the mock Marketplace of the end-to-end tests, through the form map's test hook
  const market = 'http://127.0.0.1:4321';
  const devOverrides = { createUrl: `${market}/marketplace/create/vehicle`, listingUrlPattern: `^${market.replace(/\./g, '\\.')}/marketplace/item/(\\d+)`, afterPublishPatterns: [] };
  const mock = await mine(listed(`${market}/marketplace/item/424242/`, `${market}/marketplace/you/selling`), { devOverrides });
  assert.equal((mock.match(/>Open listing</g) || []).length, 1);
  assert.match(mock, new RegExp(`href="${market.replace(/\./g, '\\.')}/marketplace/item/424242/"`));
});

// To do for a posted car the pre-owned check now questions: Dismiss keeps the
// listing up and the item off To do while the website gives that reason. A
// posted car the website retypes new is under Take down, to be deleted.
test('To do: Dismiss on a posted car that needs a look keeps it off until the reason changes; a car retyped new is to be deleted', async () => {
  const car = vehicle('usedNormal');
  const posted = { [car.vin]: { name: car.name, price: car.price, postedAt: new Date().toISOString() } };
  const lot = (patch) => Object.entries(fixtures).filter(([name]) => name !== '_about').map(([name]) => (name === 'usedNormal' ? raw(name, patch) : raw(name)));
  const first = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, [k.posted]: posted } });
  await first.scan();
  const disagree = await loadPopup({ local: first.local, records: lot({ vdp_url: 'https://example-dealer.test/inventory/new-2019-ram-1500-x/' }) });
  await disagree.scan();
  const item = disagree.local[k.diff].needsALook.find((n) => n.vin === car.vin);
  assert.deepEqual([item.yours, item.why], [true, 'review']);
  assert.match(disagree.panel(), new RegExp(`data-action="dismissLook" data-vin="${car.vin}"`));
  await disagree.click('dismissLook', { vin: car.vin });
  assert.deepEqual(disagree.local[k.posted][car.vin].lookDismissed.reason, item.text, 'the reason dismissed is kept on the listing');
  assert.equal(disagree.local[k.diff].needsALook.some((n) => n.vin === car.vin), false, 'off To do at once');
  assert.ok(disagree.local[k.posted][car.vin], 'the listing stays posted');
  await disagree.scan();
  assert.equal(disagree.local[k.diff].needsALook.some((n) => n.vin === car.vin), false, 'and on the next scan, the website giving the same reason');
  assert.doesNotMatch(disagree.panel(), /data-action="dismissLook"/);

  const NEW = { type: 'New', vdp_url: 'https://example-dealer.test/inventory/new-2019-ram-1500-x/', extra_fields: { title: 'New 2019 Ram 1500 Classic Express', readable_type: 'New', lightning: { inventoryType: 'New', vdp_title: 'New 2019 Ram 1500 Classic Express' } } };
  const retyped = await loadPopup({ local: disagree.local, records: lot(NEW) });
  await retyped.scan();
  assert.deepEqual(retyped.local[k.diff].takeDown.filter((t) => t.vin === car.vin).map((t) => t.why), ['not-pre-owned'], 'a dismissal never hides a take-down');
  assert.match(retyped.panel(), /Delete the listing: the car was not sold\./);
  assert.match(retyped.panel(), new RegExp(`data-kind="takeDown" data-vin="${car.vin}" title="Opens your listing so you can delete it"`));
  assert.equal(retyped.local[k.pilot]?.flags?.length || 0, 0, 'no sold-car flag in the numbers');
});
