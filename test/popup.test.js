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
    assert.notEqual(p.sync[PROFILE_KEY].dealer.name, host, `${how}: nor carried in the synced profile`);
    await p.scan();
    assert.equal(p.status(), '', `${how}: the scan went through`);
    const s = p.local[k.settings];
    assert.equal(s.dealer.name, STORE, `${how}: the first scan names the dealership as the website does`);
    assert.deepEqual(s.myStores, [STORE], `${how}: and ticks the website's own store`);
    const ready = Object.values(p.local[k.snapshot].vehicles).filter((v) => v.decision === 'ready');
    assert.ok(ready.length && ready.every((v) => v.location === STORE), `${how}: only this store's cars are ready to post`);
    assert.equal(p.sync[PROFILE_KEY].dealer.name, STORE, `${how}: the profile is saved again with the name`);
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
