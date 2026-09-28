import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { capStatus, postsToday, DEFAULT_DAILY_CAP } from '../extension/src/cap.js';
import { markPosted } from '../extension/src/rescan.js';
import { FORM_MAP, DEV_OVERRIDE_KEYS, applyOverrides } from '../extension/facebook/formMap.js';
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

test('the test hook can only move addresses and timings, never the fields the fill code may touch', () => {
  assert.deepEqual([...DEV_OVERRIDE_KEYS], ['createUrl', 'listingUrlPattern', 'afterPublishPatterns', 'yourListingsUrl', 'settleMs', 'recheckMs']);
  const hostile = { createUrl: 'http://127.0.0.1:1/create', fields: [{ key: 'publish', label: 'Publish', kind: 'choice', name: ['^publish'] }], neverFill: [], fileInput: 'button', settleMs: 1 };
  const map = applyOverrides(FORM_MAP, hostile);
  assert.equal(map.createUrl, 'http://127.0.0.1:1/create');
  assert.equal(map.settleMs, 1);
  assert.equal(map.fields, FORM_MAP.fields, 'the fields stay the frozen map\'s');
  assert.equal(map.neverFill, FORM_MAP.neverFill);
  assert.equal(map.fileInput, FORM_MAP.fileInput);
  assert.equal(applyOverrides(FORM_MAP, null), FORM_MAP);
  // the panel never spreads storage over the map any other way
  const panel = read('../extension/sidepanel.js');
  assert.ok(!/\.\.\.FORM_MAP/.test(panel), 'sidepanel.js must build its map with applyOverrides only');
  assert.equal((panel.match(/applyOverrides\(FORM_MAP, devOverrides\)/g) || []).length, 2);
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
  // the only element type ever clicked is a dropdown control or one of its
  // options: every .click( in the file, whatever the receiver expression
  const clicks = [...src.matchAll(/(\S+)\.click\(/g)];
  assert.ok(clicks.length >= 2, 'the dropdown clicks are still there');
  for (const m of clicks) assert.ok(['control', 'option', 'trigger'].includes(m[1]), `unexpected click on "${m[1]}"`);
  // and no click can be synthesised as an event either
  assert.ok(!/['"`]click['"`]/.test(src), 'fillForm.js must not dispatch a click event');
});

// The comment stripper above removes /* ... */ blocks; a "/*" inside a string
// would swallow real code from the guarded text, so the guarded files may
// not contain one outside a comment.
function blockOpenerInsideString(src) {
  // walk each line, tracking whether we are inside a quoted string
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let quote = null;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (quote) {
        if (c === '\\') { j++; continue; }
        if (c === quote) quote = null;
        else if (c === '/' && line[j + 1] === '*') return i + 1;
      } else if (c === "'" || c === '"' || c === '`') {
        quote = c;
      } else if (c === '/' && (line[j + 1] === '/' || line[j + 1] === '*')) {
        break; // a real comment: the rest of the line is not code
      }
    }
  }
  return 0;
}

test('the guarded files contain no block-comment opener inside a string', () => {
  assert.equal(blockOpenerInsideString("const a = 'x'; /* fine */ const b = 1;"), 0);
  assert.equal(blockOpenerInsideString("const p = ORIGIN + '/*';"), 1);
  for (const rel of ['../extension/facebook/fillForm.js', '../extension/sidepanel.js', '../extension/upkeep.js', '../extension/src/scanRunner.js', '../extension/src/scan.js']) {
    const raw = readFileSync(new URL(rel, import.meta.url), 'utf8');
    const line = blockOpenerInsideString(raw);
    assert.equal(line, 0, `${rel} line ${line} has a /* inside a string, which would blind the comment stripper`);
  }
});

test('the side panel reaches the Facebook tab only through the known fill functions', () => {
  const src = read('../extension/sidepanel.js');
  const injections = (src.match(/executeScript\(/g) || []).length;
  const known = (src.match(/func: (fillFormInPage|attachPhotosInPage|probeFormInPage)\b/g) || []).length;
  assert.ok(injections >= 3 && injections === known, `every executeScript must use one of the known fill functions (${injections} vs ${known})`);
  assert.ok(!/files:\s*\[|chrome\.debugger|tabs\.sendMessage|\.submit\s*\(|requestSubmit/i.test(src));
  // the only thing it ever clicks is its own download link
  const clicks = [...src.matchAll(/(\S+)\.click\(/g)];
  assert.ok(clicks.length >= 1);
  for (const m of clicks) assert.equal(m[1], 'a');
  assert.match(src, /a\.download = /);
});

test('the dealer-site scan reaches the dealer tab only through the read-only probe and search call', () => {
  // the wizard, the popup and the post-time re-check all go through scanRunner.js
  const runner = read('../extension/src/scanRunner.js');
  const injections = (runner.match(/executeScript\(/g) || []).length;
  const known = (runner.match(/func: (probeSiteInPage|searchInPage)\b/g) || []).length;
  assert.ok(injections === 2 && injections === known, `scanRunner.js may inject only the probe and the search call (${injections} vs ${known})`);
  const page = read('../extension/src/scan.js');
  assert.ok(!/\.click\(|dispatchEvent|\.focus\(|\.value\s*=|\.submit\s*\(|requestSubmit/.test(page), 'scan.js must only read the page');
  for (const rel of ['../extension/wizard.js', '../extension/popup.js', '../extension/src/vehicleDetails.js']) {
    assert.ok(!/executeScript\(/.test(read(rel)), `${rel} must not inject into pages itself`);
  }
});

test('listing upkeep only reads the listing page and fills the Price box; the person clicks Update, Mark as sold or Delete', () => {
  const src = read('../extension/upkeep.js');
  const injections = (src.match(/executeScript\(/g) || []).length;
  const known = (src.match(/func: (fillPriceInPage|readListingInPage)\b/g) || []).length;
  assert.ok(injections === 2 && injections === known, `upkeep.js may inject only the price filler and the listing reader (${injections} vs ${known})`);
  assert.ok(!/\.click\(|['"`]click['"`]|files:\s*\[|chrome\.debugger|tabs\.sendMessage|\.submit\s*\(|requestSubmit|tabs\.remove/i.test(src), 'upkeep.js must not click, close tabs or submit');
  // nothing is filled or ticked off unless the page is this car's listing
  assert.match(src, /matchesId \|\| seen\.matchesName/);
  assert.match(src, /if \(!onTarget\) return;/);
  // a sold/removed sign counts only when it appeared after the first read
  assert.match(src, /seen\.sold && !up\.baseline\.sold/);
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
