import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { capStatus, postsToday, DEFAULT_DAILY_CAP } from '../extension/src/cap.js';
import { markPosted } from '../extension/src/rescan.js';
import { FORM_MAP } from '../extension/facebook/formMap.js';
import { snapshot, fixtures } from './helpers.js';

const VIN = fixtures.usedNormal.vin;

test('daily cap counts only today, in local time', () => {
  const now = new Date(2026, 8, 26, 15, 0); // Sept 26, 3pm local
  const posted = {
    a: { postedAt: new Date(2026, 8, 26, 9, 0).toISOString() },
    b: { postedAt: new Date(2026, 8, 26, 0, 5).toISOString() },
    c: { postedAt: new Date(2026, 8, 25, 23, 55).toISOString() },
    d: { postedAt: 'garbage' },
    e: {},
  };
  assert.equal(postsToday(posted, now), 2);
  assert.deepEqual(capStatus(posted, 10, now), { used: 2, cap: 10, remaining: 8, reached: false });
  assert.deepEqual(capStatus(posted, 2, now), { used: 2, cap: 2, remaining: 0, reached: true });
  assert.equal(capStatus(posted, 0, now).cap, DEFAULT_DAILY_CAP);
  assert.equal(capStatus(posted, 'nope', now).cap, DEFAULT_DAILY_CAP);
  assert.equal(capStatus({}, undefined, now).reached, false);
});

test('the posted registry can carry the listing link and who posted, without breaking old callers', () => {
  const s = snapshot([['usedNormal']]);
  const plain = markPosted({}, s.vehicles[VIN], 'website', '2026-09-26T21:00:00.000Z');
  assert.deepEqual(plain[VIN], { name: '2019 Ram 1500 Classic Express', price: 27163, postedAt: '2026-09-26T21:00:00.000Z' });
  const full = markPosted({}, s.vehicles[VIN], 'beforeFees', '2026-09-26T21:00:00.000Z', {
    listingUrl: 'https://www.facebook.com/marketplace/item/424242/',
    salesperson: 'Roger',
  });
  assert.deepEqual(full[VIN], {
    name: '2019 Ram 1500 Classic Express',
    price: 26673,
    postedAt: '2026-09-26T21:00:00.000Z',
    listingUrl: 'https://www.facebook.com/marketplace/item/424242/',
    salesperson: 'Roger',
  });
});

// Non-negotiable #1, enforced on the source itself: nothing in the Facebook
// code can publish, update, delete or mark a listing sold.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (rel) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));

test('the form map has no selector, name or option that could reach Publish, Update, Delete or Mark as sold', () => {
  const strings = [];
  (function walk(x) {
    if (typeof x === 'string') strings.push(x.toLowerCase());
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  })(FORM_MAP);
  for (const word of ['publish', 'submit', 'delete', 'sold', 'update listing', 'post listing', 'button[type']) {
    assert.ok(!strings.some((s) => s.includes(word)), `formMap has a value mentioning "${word}"`);
  }
  assert.ok(!FORM_MAP.fields.some((f) => /publish|submit|delete|sold/i.test(f.key + f.label)));
  assert.ok(!Object.keys(FORM_MAP).some((k) => /selector|button/i.test(k) && k !== 'fileInput'), 'no button selectors at all');
});

test('the fill code never submits a form or clicks anything but a dropdown option', () => {
  const src = read('../extension/facebook/fillForm.js');
  // the read-only probe and the listing reader must not act on the page at all
  const probe = src.slice(src.indexOf('function probeFormInPage'), src.indexOf('function fillPriceInPage'));
  assert.ok(probe.length > 100 && !/\.click\(\)|dispatchEvent|\.focus\(\)|\.value\s*=/.test(probe), 'probeFormInPage must be read-only');
  const reader = src.slice(src.indexOf('function readListingInPage'), src.indexOf('function attachPhotosInPage'));
  assert.ok(reader.length > 100 && !/\.click\(\)|dispatchEvent|\.focus\(\)|\.value\s*=/.test(reader), 'readListingInPage must be read-only');
  // the price filler touches one box and never clicks
  const pricer = src.slice(src.indexOf('function fillPriceInPage'), src.indexOf('function readListingInPage'));
  assert.ok(pricer.length > 100 && !/\.click\(\)/.test(pricer), 'fillPriceInPage must not click');
  assert.ok(!/\.submit\s*\(|requestSubmit|\bpublish\b|mark as sold|\bdelete\b/i.test(src), 'fillForm.js must not contain submit/publish/delete paths');
  assert.ok(!/type\s*=\s*["']submit["']/i.test(src));
  // the only element type ever clicked is a dropdown control or one of its options
  for (const m of src.matchAll(/(\w+)\.click\(\)/g)) {
    assert.ok(['control', 'option', 'trigger'].includes(m[1]), `unexpected click on "${m[1]}"`);
  }
});

test('the side panel reaches the Facebook tab only through the known fill functions', () => {
  const src = read('../extension/sidepanel.js');
  const injections = (src.match(/executeScript\(/g) || []).length;
  const known = (src.match(/func: (fillFormInPage|attachPhotosInPage|probeFormInPage)\b/g) || []).length;
  assert.ok(injections >= 3 && injections === known, `every executeScript must use one of the known fill functions (${injections} vs ${known})`);
  assert.ok(!/files:\s*\[|chrome\.debugger|tabs\.sendMessage|\.submit\s*\(|requestSubmit/i.test(src));
  // the only thing it ever clicks is its own download link
  for (const m of src.matchAll(/(\w+)\.click\(\)/g)) assert.equal(m[1], 'a');
  assert.match(src, /a\.download = /);
});

test('listing upkeep only reads the listing page and fills the Price box; the person clicks Update, Mark as sold or Delete', () => {
  const src = read('../extension/upkeep.js');
  const injections = (src.match(/executeScript\(/g) || []).length;
  const known = (src.match(/func: (fillPriceInPage|readListingInPage)\b/g) || []).length;
  assert.ok(injections === 2 && injections === known, `upkeep.js may inject only the price filler and the listing reader (${injections} vs ${known})`);
  assert.ok(!/\.click\(\)|files:\s*\[|chrome\.debugger|tabs\.sendMessage|\.submit\s*\(|requestSubmit|tabs\.remove/i.test(src), 'upkeep.js must not click, close tabs or submit');
  // the signs it watches for are text patterns, never selectors for controls
  const signs = read('../extension/facebook/listingSigns.js');
  assert.ok(!/button|role=|querySelector|\.click|\[data-/i.test(signs), 'listingSigns.js must describe text only');
});

test('the background worker and the listing watcher never touch the page', () => {
  for (const rel of ['../extension/background.js', '../extension/facebook/detectPost.js']) {
    const src = read(rel);
    assert.ok(!/\.click\(\)|\.submit\s*\(|requestSubmit|executeScript|tabs\.sendMessage/i.test(src), `${rel} must not act on any page`);
  }
});
