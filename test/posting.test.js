import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { capStatus, postsToday, DEFAULT_DAILY_CAP } from '../extension/src/cap.js';
import { markPosted } from '../extension/src/rescan.js';
import { FORM_MAP, DEV_OVERRIDE_KEYS, applyOverrides } from '../extension/facebook/formMap.js';
import { ADAPTERS } from '../extension/adapters/index.js';
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

// The text of a function declared in `src`, from `function name(` to its
// closing brace (braces inside quoted strings and line comments are
// skipped). '' when missing.
function bodyOf(src, name) {
  const start = src.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) return '';
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
    } else if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      if (i < 0) return '';
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return '';
}

// What these source checks prove: the usual ways to click, submit or inject
// in ordinary code are caught. Code written to hide a click from them (a
// method name built from pieces, say) is for code review; the e2e mock form
// also counts real clicks on its own Publish button.
test('the fill code never submits a form, and clicks only inside the dropdown and checkbox helpers', () => {
  const src = read('../extension/facebook/fillForm.js');
  // the read-only probe and the listing reader must not act on the page at all
  const probe = src.slice(src.indexOf('function probeFormInPage'), src.indexOf('function fillPriceInPage'));
  assert.ok(probe.length > 100 && !/\.click\b|dispatchEvent|\.focus\(\)|\.value\s*=/.test(probe), 'probeFormInPage must be read-only');
  const reader = src.slice(src.indexOf('function readListingInPage'), src.indexOf('function attachPhotosInPage'));
  assert.ok(reader.length > 100 && !/\.click\b|dispatchEvent|\.focus\(\)|\.value\s*=/.test(reader), 'readListingInPage must be read-only');
  // the price filler touches one box and never clicks
  const pricer = src.slice(src.indexOf('function fillPriceInPage'), src.indexOf('function readListingInPage'));
  assert.ok(pricer.length > 100 && !/\.click\b/.test(pricer), 'fillPriceInPage must not click');
  // no submit by any spelling (form.submit(), requestSubmit, ['submit'], a submit button), and no Publish, Mark as sold or Delete
  assert.ok(!/submit|\bpublish\b|mark as sold|\bdelete\b/i.test(src), 'fillForm.js must not contain submit/publish/delete paths');
  // every click sits in one of three helpers, one click each: opening a
  // dropdown, choosing one of its options, ticking a checkbox the map names.
  // Anywhere else, .click in any form (a call, .click.call or .apply,
  // HTMLElement.prototype.click) fails, whatever the receiver is called.
  let rest = src;
  for (const helper of ['openDropdown', 'chooseOption', 'setCheckbox']) {
    const body = bodyOf(src, helper);
    assert.ok(body.length > 50, `${helper} is still there`);
    assert.equal((body.match(/\.click\b/g) || []).length, 1, `${helper} has exactly one click`);
    assert.equal((body.match(/\.click\(\)/g) || []).length, 1, `${helper}'s click is a plain call`);
    rest = rest.replace(body, '');
  }
  assert.ok(!/\.click\b|\bclick\s*\(/.test(rest), 'fillForm.js clicks only inside openDropdown, chooseOption and setCheckbox');
  // and no click can be synthesised as an event, and no Enter pressed (Enter commits a form)
  assert.ok(!/['"`]click['"`]/.test(src), 'fillForm.js must not dispatch a click event');
  assert.ok(!/['"`]Enter['"`]/.test(src), 'fillForm.js must not press Enter');
});

test('bodyOf finds a helper whole, braces in strings and comments and all', () => {
  const src = "function a(x) {\n  if (x) { return '}'; } // isn't {\n  return \"{\";\n}\nfunction b() { return 1; }\n";
  assert.equal(bodyOf(src, 'a'), "function a(x) {\n  if (x) { return '}'; } // isn't {\n  return \"{\";\n}");
  assert.equal(bodyOf(src, 'b'), 'function b() { return 1; }');
  assert.equal(bodyOf(src, 'c'), '');
});

// Every .js file under extension/, wherever it sits: a new module is checked
// the day it is added, without a list here to update.
function extensionFiles(dir = new URL('../extension/', import.meta.url), prefix = '') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...extensionFiles(new URL(e.name + '/', dir), prefix + e.name + '/'));
    else if (/\.m?js$/.test(e.name)) out.push(prefix + e.name);
  }
  return out;
}

// The only files that inject into a page, and what each may inject: a
// function imported from the module the guards above check, by the name it
// is exported under. The adapters' own probe and search are checked in the
// dealer-site test below for every adapter in ADAPTERS.
const INJECTORS = {
  'sidepanel.js': { './facebook/fillForm.js': ['fillFormInPage', 'attachPhotosInPage', 'probeFormInPage'] },
  'upkeep.js': { './facebook/fillForm.js': ['fillPriceInPage', 'readListingInPage'] },
  'src/scanRunner.js': { './scan.js': ['probeSiteInPage'] },
};
const ADAPTER_FUNCS = ['adapter.probeInPage', 'adapter.searchInPage'];

// The argument text of every call to `name(` in src, parentheses balanced.
function callArgs(src, name) {
  const out = [];
  for (const m of src.matchAll(new RegExp(`\\b${name}\\(`, 'g'))) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) {
        out.push(src.slice(m.index + m[0].length, i));
        break;
      }
    }
  }
  return out;
}

function injectionProblems(file, src) {
  const problems = [];
  // chrome.scripting only to call executeScript, spelled out (no alias, no registerContentScripts)
  const scripting = (src.match(/\bscripting\b/g) || []).length;
  const calls = callArgs(src, 'chrome\\.scripting\\.executeScript');
  if (scripting !== calls.length || (src.match(/executeScript/g) || []).length !== calls.length) problems.push(`${file}: chrome.scripting is used other than as chrome.scripting.executeScript(...)`);
  if (/chrome\.debugger|tabs\.sendMessage/.test(src)) problems.push(`${file}: another way into a page`);
  // outside the adapters, the adapters' in-page functions are only ever reached through an adapter object, never defined
  if (!file.startsWith('adapters/') && /\b(probeInPage|searchInPage)\b/.test(src.replace(/\badapter\.(probeInPage|searchInPage)\b/g, ''))) problems.push(`${file}: defines or names probeInPage/searchInPage outside an adapter`);
  if (!calls.length) return problems;
  const allowed = INJECTORS[file];
  if (!allowed) return [...problems, `${file}: injects into a page, and only ${Object.keys(INJECTORS).join(', ')} may`];
  const names = Object.values(allowed).flat();
  for (const args of calls) {
    const func = /\bfunc:\s*([\w$.]+)/.exec(args);
    if (/\bfiles\s*:/.test(args)) problems.push(`${file}: injects files`);
    if (!func || !(names.includes(func[1]) || (file === 'src/scanRunner.js' && ADAPTER_FUNCS.includes(func[1])))) problems.push(`${file}: injects ${func ? func[1] : 'something with no func'}`);
  }
  // each name is the imported function itself: it appears once in its import
  // and otherwise only as func: (no local function, variable or parameter of that name)
  for (const [from, list] of Object.entries(allowed)) {
    for (const name of list) {
      const imported = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]${from.replace(/[.]/g, '\\.')}['"]`).test(src);
      const uses = (src.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length;
      const asFunc = (src.match(new RegExp(`\\bfunc:\\s*${name}\\b`, 'g')) || []).length;
      if (asFunc && (!imported || uses !== asFunc + 1)) problems.push(`${file}: ${name} is not only the one imported from ${from}`);
    }
  }
  return problems;
}

test('every file of the extension reaches a page only through the known injected functions, imported from their checked modules', () => {
  const files = extensionFiles();
  assert.ok(files.length > 20 && files.includes('src/pilot.js') && files.includes('facebook/fillForm.js'), 'every folder is walked');
  const problems = [];
  let injecting = 0;
  for (const file of files) {
    const src = read('../extension/' + file);
    if (/executeScript/.test(src)) injecting += 1;
    problems.push(...injectionProblems(file, src));
  }
  assert.deepEqual(problems, []);
  assert.equal(injecting, Object.keys(INJECTORS).length, 'the three injecting files are found');

  // the check itself: each way round it that ordinary code could take fails
  const panel = read('../extension/sidepanel.js');
  const planted = {
    'a new module that injects': ['src/pilot.js', "async function x(id) { await chrome.scripting.executeScript({ target: { tabId: id }, func: probeFormInPage }); }"],
    'a local function under a known name': ['sidepanel.js', panel + '\nconst probeFormInPage = () => null;\n'],
    'a parameter under a known name': ['sidepanel.js', panel.replace('async function runProbe() {', 'async function runProbe(probeFormInPage) {')],
    'an alias of executeScript': ['sidepanel.js', panel + '\nconst inject = chrome.scripting.executeScript;\n'],
    'a content script registered at run time': ['upkeep.js', read('../extension/upkeep.js') + "\nchrome.scripting.registerContentScripts([]);\n"],
    'an injected file': ['upkeep.js', read('../extension/upkeep.js').replace('func: fillPriceInPage', "files: ['x.js'], func: fillPriceInPage")],
    'a function from elsewhere': ['upkeep.js', read('../extension/upkeep.js').replace('func: fillPriceInPage', 'func: somethingElse')],
  };
  for (const [what, [file, src]] of Object.entries(planted)) assert.ok(injectionProblems(file, src).length, `${what} is caught`);
});

// The other way onto a page needs no code at all: the manifest. A content
// script (or files a page may load, or a page allowed to message the
// extension) would run on every Marketplace page the salesperson opens, with
// no side panel and nobody at the keyboard; the existing Marketplace host
// permission is enough for Chrome to run one. The manifest declares none.
const PAGE_KEYS = ['content_scripts', 'web_accessible_resources', 'externally_connectable', 'user_scripts'];
// and the permissions that run code in a page without chrome.scripting
const PAGE_PERMISSIONS = ['debugger', 'userScripts', 'declarativeContent'];
function manifestPageProblems(m) {
  const problems = PAGE_KEYS.filter((k) => k in m).map((k) => `the manifest declares ${k}`);
  for (const p of [...(m.permissions || []), ...(m.optional_permissions || [])]) if (PAGE_PERMISSIONS.includes(p)) problems.push(`the manifest asks for ${p}`);
  return problems;
}

test('the manifest runs nothing on a page by itself: no content script, no files for pages, no page messaging the extension', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifestPageProblems(manifest), []);
  // the check itself
  const planted = {
    'a Marketplace content script': { content_scripts: [{ matches: ['https://www.facebook.com/marketplace/*'], js: ['facebook/x.js'] }] },
    'files a page may load': { web_accessible_resources: [{ resources: ['facebook/x.js'], matches: ['https://www.facebook.com/*'] }] },
    'a page that may message the extension': { externally_connectable: { matches: ['https://www.facebook.com/*'] } },
    'the debugger': { permissions: [...manifest.permissions, 'debugger'] },
    'user scripts': { optional_permissions: ['userScripts'] },
  };
  for (const [what, patch] of Object.entries(planted)) assert.ok(manifestPageProblems({ ...manifest, ...patch }).length, `${what} is caught`);
});

// The comment stripper above removes /* ... */ blocks; a "/*" inside a string
// would swallow real code from the guarded text, so no file of the extension
// (every one is walked above) may contain one outside a comment. A match
// pattern is written origin + '/' + '*'.
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

test('no file of the extension contains a block-comment opener inside a string', () => {
  assert.equal(blockOpenerInsideString("const a = 'x'; /* fine */ const b = 1;"), 0);
  assert.equal(blockOpenerInsideString("const p = ORIGIN + '/*';"), 1);
  assert.equal(blockOpenerInsideString("const p = ORIGIN + '/' + '*';"), 0);
  const files = extensionFiles();
  assert.ok(['wizard.js', 'src/rescanSchedule.js', 'sidepanel.js', 'facebook/fillForm.js', 'adapters/dealerInspire.js'].every((f) => files.includes(f)), 'every folder is walked');
  for (const file of files) {
    const raw = readFileSync(new URL('../extension/' + file, import.meta.url), 'utf8');
    const line = blockOpenerInsideString(raw);
    assert.equal(line, 0, `extension/${file} line ${line} has a /* inside a string, which would blind the comment stripper`);
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
