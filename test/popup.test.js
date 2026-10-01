// The popup (extension/popup.js), clicked through in Node over
// test/popupHarness.js: what its buttons write and what its tabs draw.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPopup, POPUP_ORIGIN } from './popupHarness.js';
import { fixtures, raw, vehicle, sampleVin, MY_STORE } from './helpers.js';
import { PROFILE_KEY } from '../extension/src/settings.js';
import { siteKeys } from '../extension/src/storageKeys.js';

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
