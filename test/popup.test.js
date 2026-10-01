// The popup (extension/popup.js), clicked through in Node over
// test/popupHarness.js: what its buttons write and what its tabs draw.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPopup, POPUP_ORIGIN } from './popupHarness.js';
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
