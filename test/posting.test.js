import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { capStatus, postsToday, DEFAULT_DAILY_CAP } from '../extension/src/cap.js';
import { markPosted } from '../extension/src/rescan.js';
import { FORM_MAP, DEV_OVERRIDE_KEYS, applyOverrides } from '../extension/facebook/formMap.js';
import { ADAPTERS } from '../extension/adapters/index.js';
import { snapshot, fixtures, stripComments, commentStripperBlindSpots, strippedSourceFiles } from './helpers.js';

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
// code can publish, update, delete or mark a listing sold. The source is read
// without its comments (stripComments, test/helpers.js).
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

// The comment stripper removes /* ... */ blocks with a regex, so a "/*" that
// does not open a comment (inside a string, a template or a // comment) would
// swallow real code up to the next "*/" and blind every guard test reading
// that file. Every file any guard test reads through it is held to having none.
test('no file the guard tests read has a "/*" the comment stripper would mistake for a comment', () => {
  // the scanner itself, on the shapes that have hidden code before
  assert.deepEqual(commentStripperBlindSpots("const a = 'x'; /* fine */ const b = 1;\n/**\n * a doc comment\n */\nf(); /* one line */\n"), []);
  assert.deepEqual(commentStripperBlindSpots("const p = ORIGIN + '/*';"), ['line 1: "/*" inside a string']);
  const tabLookup = "try {\n  const tabs = await chrome.tabs.query({ url: origin + '/*' });\n  chrome.scripting.executeScript({ target, func });\n} catch (e) { /* no access */ }\n";
  assert.doesNotMatch(stripComments(tabLookup), /executeScript/, 'the regex stripper hides the line in between');
  assert.deepEqual(commentStripperBlindSpots(tabLookup), ['line 2: "/*" inside a string']);
  assert.deepEqual(commentStripperBlindSpots('const t = `a\n${b ? `x` : \'\'} c/*\n`;\n/* d */'), ['line 2: "/*" inside a template literal']);
  assert.deepEqual(commentStripperBlindSpots('// reads src/*.js\nhidden();\n/* real */\n'), ['line 1: "/*" inside a // comment']);
  assert.deepEqual(commentStripperBlindSpots('const re = /[/*]/; hidden();\n/* real */\n'), ['line 1: a block comment that runs past its line starts after code']);
  assert.deepEqual(commentStripperBlindSpots("const p = origin + '/' + '*'; /* skip */"), [], 'the split form the extension uses');
  // the trailing mode cuts a // comment after code, never the code after a regex literal that ends in \/\/
  const afterRegex = "const isWeb = (u) => /^https?:\\/\\//i.test(u) && hidden(u); // why\n";
  assert.equal(stripComments(afterRegex, { trailing: true }), "const isWeb = (u) => /^https?:\\/\\//i.test(u) && hidden(u); \n");
  assert.equal(stripComments("go('https://x'); // why\n", { trailing: true }), "go('https://x'); \n");
  // every file the guard tests read: the extension, the rewrite service, the manager view, the website, the Edge Functions, the sandbox
  const files = strippedSourceFiles();
  for (const must of ['extension/wizard.js', 'extension/sidepanel.js', 'extension/src/rescanSchedule.js', 'extension/facebook/fillForm.js', 'backend/server.js', 'manager/manager.js', 'demo/demo.js']) assert.ok(files.includes(must), `${must} is not read`);
  for (const rel of files) assert.deepEqual(commentStripperBlindSpots(readFileSync(new URL('../' + rel, import.meta.url), 'utf8')), [], `${rel}: the comment stripper would hide code here (write '/' + '*' instead)`);
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

// The rewrite service bills and caps the store whose website origin comes
// with the request; without it, a person in two sister stores is charged to
// whichever membership comes first. The handler's side is in
// test/fn-rewrite.test.js; this holds the panel to sending it.
test('the side panel sends the dealer website\'s origin with every draft and colour guess it asks the rewrite service for', () => {
  const src = read('../extension/sidepanel.js');
  for (const name of ['generateDescription', 'guessColorsWithBackend']) {
    const calls = src.split(`${name}(`).length - 1;
    const withOrigin = (src.match(new RegExp(`${name}\\(\\{[^}]*\\borigin: state\\.origin\\b[^}]*\\}\\)`, 'g')) || []).length;
    assert.ok(calls >= 1 && withOrigin === calls, `every ${name} call in sidepanel.js must pass origin: state.origin (${withOrigin} of ${calls})`);
  }
});

test('the dealer-site scan reaches the dealer tab only through the neutral probe and each adapter\'s own read-only probe and search', () => {
  // the wizard, the popup and the post-time re-check all go through scanRunner.js
  const runner = read('../extension/src/scanRunner.js');
  const injections = (runner.match(/executeScript\(/g) || []).length;
  const known = (runner.match(/func: (probeSiteInPage|adapter\.probeInPage|adapter\.searchInPage)\b/g) || []).length;
  assert.ok(injections === 3 && injections === known, `scanRunner.js may inject only the neutral probe and the adapters' probe and search (${injections} vs ${known})`);
  assert.ok(!/files:\s*\[|chrome\.debugger|tabs\.sendMessage/.test(runner), 'no other way into a page');
  // word forms and indirect calls too: no click or submit by any name, no
  // assignment into the page, no navigation, no call/apply/Reflect/eval
  // that could reach one of those another way
  const READ_ONLY = /\bclick\b|\bsubmit\b|requestSubmit|dispatchEvent|\.focus\b|\.value\s*[?|&+-]*=|\.innerHTML\s*=|\.setAttribute\(|\.insertAdjacentHTML|location\.(href|assign|replace)|\.call\(|\.apply\(|Reflect\.|new Function|\beval\b/;
  const page = read('../extension/src/scan.js');
  assert.ok(!READ_ONLY.test(page), 'scan.js must only read the page');
  assert.ok(ADAPTERS.length >= 1);
  for (const adapter of ADAPTERS) {
    for (const name of ['probeInPage', 'searchInPage']) {
      const src = stripComments(String(adapter[name]));
      assert.ok(src.length > 50, `${adapter.PLATFORM.id}.${name} exists`);
      assert.ok(!READ_ONLY.test(src), `${adapter.PLATFORM.id}.${name} must only read the page`);
      assert.ok(!/['"`]click['"`]/.test(src), `${adapter.PLATFORM.id}.${name} must not name a click event`);
    }
  }
  for (const rel of ['../extension/wizard.js', '../extension/popup.js', '../extension/src/vehicleDetails.js', '../extension/adapters/index.js']) {
    assert.ok(!/executeScript\(/.test(read(rel)), `${rel} must not inject into pages itself`);
  }
  // no adapter file injects either: the runner is the only place that does
  for (const file of readdirSync(new URL('../extension/adapters/', import.meta.url)).filter((f) => /\.js$/.test(f))) {
    assert.ok(!/executeScript\(|permissions\.request/.test(read('../extension/adapters/' + file)), `adapters/${file} must not inject into pages or ask for permissions`);
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
