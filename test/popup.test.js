// The popup (extension/popup.js), clicked through in Node over
// test/popupHarness.js: what its buttons write and what its tabs draw.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPopup, POPUP_ORIGIN } from './popupHarness.js';
import { fixtures, raw, vehicle, sampleVin, MY_STORE } from './helpers.js';
import { PROFILE_KEY } from '../extension/src/settings.js';
import { siteKeys } from '../extension/src/storageKeys.js';
import { POSTING_RULES } from '../extension/src/postingRules.js';
import { noteFlags, resolveFlag, beginPost, endPost, noteFill } from '../extension/src/pilot.js';

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
    [theirs.vin]: { name: theirs.name, price: theirs.price, postedAt: at, listingUrl: 'https://listing.example.test/1', ...colleague },
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
  assert.match(theirPart, /href="https:\/\/listing\.example\.test\/1"/, 'with the link to the listing');
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
  const syncState = { version: 1, since: '2026-10-01T10:00:00.000Z', known: [] };
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

  // nothing refused: no banner
  const q = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, [k.posted]: posted, [k.sync]: { ...syncState, notShared: [] }, account: session } });
  await q.scan();
  assert.doesNotMatch(q.panel(), /notSharedBanner/);
});

// Changing "Price to post" moves the person's listings to the new basis:
// each must be edited by hand, but the website did not change, so they are
// warned before saving, and To do and My listings say "Price to post changed
// in Settings", never "Website price changed", and the numbers do not count
// them as price changes.
test('a change of Price to post is warned about, then listed apart from website price changes and kept out of the numbers', async () => {
  const ram = vehicle('usedNormal'); // $27,163, or $26,673 before the fee
  const posted = { [ram.vin]: { name: ram.name, price: ram.price, postedAt: new Date().toISOString() } }; // recorded before entries carried a basis
  const p = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, [k.posted]: posted } });
  await p.scan();
  assert.doesNotMatch(p.panel(), /Update price|Price to post changed/, 'posted at the website price: nothing to do');

  await p.tab('settings');
  assert.match(p.panel(), /id="basisWarning">You have one posted listing on this website\. If its car shows a lower second price, changing the price to post changes its price too: after the next rescan it is listed under To do, "Price to post changed in Settings", for you to edit its price, and the price note in its description, on Facebook\. Facebook may tell people who saved a car that its price changed\./);
  const values = { salespersonName: 'Sam', dailyCap: '10', basis: 'beforeFees' };
  const before = globalThis.FormData;
  globalThis.FormData = class { get(name) { return values[name] ?? null; } getAll(name) { return name === 'store' ? MY_STORE.myStores : []; } has(name) { return name in values; } };
  // the order of the writes: a background rescan between them must find the listing stamped with its old basis before it can read the new one
  const writes = [];
  const set = globalThis.chrome.storage.local.set;
  globalThis.chrome.storage.local.set = async (obj) => { writes.push(...Object.keys(obj)); return set(obj); };
  try {
    await p.el('panel').listeners.submit({ target: { id: 'settings', querySelector: () => null }, preventDefault() {} });
  } finally {
    globalThis.FormData = before;
    globalThis.chrome.storage.local.set = set;
  }
  assert.equal(p.local[k.settings].basis, 'beforeFees');
  assert.equal(p.local[k.posted][ram.vin].basis, 'website', 'the listing is recorded as posted under the basis in force until now');
  assert.ok(writes.includes(k.posted) && writes.indexOf(k.posted) < writes.indexOf(k.settings), `the listing is stamped before the new basis is saved (writes: ${writes.join(', ')})`);
  assert.equal(p.el('saved').textContent, 'Saved. Click Rescan website to apply. After the next rescan, your posted listing is listed under To do to edit to the new price to post, if its car shows a lower second price.');

  await p.scan();
  const todo = p.panel();
  assert.match(todo, /<h3>Price to post changed in Settings <span class="pill warn">1<\/span><\/h3>/);
  assert.match(todo, /posted under the earlier "Price to post" choice\. Edit its price, and the price note in its description if it has one\./);
  assert.match(todo, new RegExp(`data-action="upkeep" data-kind="price" data-vin="${ram.vin}" data-price="26673"`), 'the listing still has to follow the chosen basis');
  assert.doesNotMatch(todo, /<h3>Update price/, 'not a website price change');
  assert.deepEqual((p.local[k.pilot]?.flags || []).filter((f) => f.kind === 'price'), [], 'and not counted as one');
  await p.tab('mine');
  assert.match(p.panel(), /<span class="pill warn">Price to post changed in Settings<\/span>/);
  assert.doesNotMatch(p.panel(), /Website price changed/);

  // Updated: the listing now shows the new basis's price, recorded with it
  await p.click('priceUpdated', { vin: ram.vin, price: '26673' });
  assert.deepEqual([p.local[k.posted][ram.vin].price, p.local[k.posted][ram.vin].basis], [26673, 'beforeFees']);
  await p.scan();
  assert.doesNotMatch(p.panel(), /Update price|Price to post changed/, 'nothing left to do');
});

// A To do item listed before "Price to post" changed still carries the price
// the scan took under the earlier choice. Acting on it after the change
// records that price with the basis it really is, so the next rescan tells
// the basis change apart instead of counting a website price change that
// never happened.
test('a price item listed before Price to post changed is recorded with its own basis, so the next rescan counts no website price change', async () => {
  const ram = vehicle('usedNormal'); // $27,163 on the website, or $26,673 before the fee
  const posted = { [ram.vin]: { name: ram.name, price: 27663, postedAt: new Date().toISOString(), basis: 'website' } }; // listed at the website's earlier $27,663
  const p = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, [k.posted]: posted } });
  await p.scan();
  const flagged = (p.local[k.pilot]?.flags || []).filter((f) => f.kind === 'price' && f.vin === ram.vin);
  assert.equal(flagged.length, 1, 'the website really dropped $500: one price change');
  assert.match(p.panel(), new RegExp(`data-action="priceUpdated" data-vin="${ram.vin}" data-price="27163" data-basis="website"`), 'the item names the basis its price was taken at');

  // Price to post changes before the person gets to the item; To do still shows it until the next rescan
  await p.tab('settings');
  const values = { salespersonName: 'Sam', dailyCap: '10', basis: 'beforeFees' };
  const before = globalThis.FormData;
  globalThis.FormData = class { get(name) { return values[name] ?? null; } getAll(name) { return name === 'store' ? MY_STORE.myStores : []; } has(name) { return name in values; } };
  try {
    await p.el('panel').listeners.submit({ target: { id: 'settings', querySelector: () => null }, preventDefault() {} });
  } finally {
    globalThis.FormData = before;
  }
  assert.equal(p.local[k.settings].basis, 'beforeFees');
  await p.tab('todo');
  const button = new RegExp(`data-action="priceUpdated" data-vin="${ram.vin}" data-price="(\\d+)" data-basis="(\\w+)"`).exec(p.panel());
  assert.deepEqual(button && button.slice(1), ['27163', 'website'], 'the stale item still says what it is');

  // the person set the listing to the item's $27,163 and clicks Updated on it
  await p.click('priceUpdated', { vin: ram.vin, price: button[1], basis: button[2] });
  assert.deepEqual([p.local[k.posted][ram.vin].price, p.local[k.posted][ram.vin].basis], [27163, 'website'], 'the website\'s main price, recorded as the main price');

  await p.scan();
  const todo = p.panel();
  assert.match(todo, /<h3>Price to post changed in Settings <span class="pill warn">1<\/span><\/h3>/, 'the move to the new basis is still to do');
  assert.doesNotMatch(todo, /<h3>Update price/, 'the website did not change again');
  assert.equal((p.local[k.pilot]?.flags || []).filter((f) => f.kind === 'price' && f.vin === ram.vin).length, 1, 'and the numbers count only the one real price change');
});

// On a website that shows no lower second price there is no other price to
// post, so Settings warns about nothing.
test('Settings warns about a change of Price to post only where the website shows a lower second price', async () => {
  const records = Object.entries(fixtures).filter(([name]) => name !== '_about').map(([name]) => raw(name, { pricing: { price: 0, internet_price: 0 } }));
  const ram = vehicle('usedNormal');
  const posted = { [ram.vin]: { name: ram.name, price: ram.price, postedAt: new Date().toISOString(), basis: 'website' } };
  const p = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, [k.posted]: posted }, records });
  await p.scan();
  assert.equal(p.status(), '', 'the scan went through');
  await p.tab('settings');
  assert.doesNotMatch(p.panel(), /value="beforeFees"/, 'no lower price to choose');
  assert.doesNotMatch(p.panel(), /basisWarning/, 'so nothing to warn about');

  const q = await loadPopup({ local: { [k.settings]: { ...MY_STORE }, [k.posted]: posted } });
  await q.scan();
  await q.tab('settings');
  assert.match(q.panel(), /value="beforeFees"/);
  assert.match(q.panel(), /id="basisWarning">You have one posted listing/, 'where there is one, the warning is beside it');
});
