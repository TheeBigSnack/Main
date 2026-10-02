import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { capStatus, postsToday, DEFAULT_DAILY_CAP } from '../extension/src/cap.js';
import { markPosted } from '../extension/src/rescan.js';
import { FORM_MAP, DEV_OVERRIDE_KEYS, applyOverrides } from '../extension/facebook/formMap.js';
import { ADAPTERS } from '../extension/adapters/index.js';
import { probeSiteInPage } from '../extension/src/scan.js';
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
  assert.deepEqual(plain[VIN], { name: '2019 Ram 1500 Classic Express', price: 27163, postedAt: '2026-09-26T21:00:00.000Z', basis: 'website' });
  const full = markPosted({}, s.vehicles[VIN], 'beforeFees', '2026-09-26T21:00:00.000Z', {
    listingUrl: 'https://www.facebook.com/marketplace/item/424242/',
    salesperson: 'Roger',
  });
  assert.deepEqual(full[VIN], {
    name: '2019 Ram 1500 Classic Express',
    price: 26673,
    postedAt: '2026-09-26T21:00:00.000Z',
    basis: 'beforeFees',
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

// Code injected into the dealer's tab (src/scan.js probeSiteInPage, every
// adapter's probeInPage and searchInPage) only reads the page. This guard is
// a text check for the usual spellings of acting on it, and it looks for
// exactly these, written with a dot where a dot is shown:
//  - clicks, events, focus, scrolling: click and submit (as words, so by any
//    name), requestSubmit, dispatchEvent, .focus, .blur(, scrollIntoView,
//    scroll(, scrollTo(, scrollBy(;
//  - an assignment (=, +=, ??= and the like) to .value, .checked, .selected,
//    .selectedIndex, .files, .textContent, .innerText, .outerText,
//    .innerHTML, .outerHTML, .nodeValue, .className, .classList, .style,
//    .hidden, .disabled, .contentEditable, .src, .srcdoc, .href, .action,
//    .style.<any>, .dataset.<any>, document.title, document.designMode or
//    document.body; .style.setProperty, .style.removeProperty,
//    .style.cssText; .classList.add(, .remove(, .toggle(, .replace(;
//  - attributes: .setAttribute(, .setAttributeNS(, .setAttributeNode(,
//    .setAttributeNodeNS(, .removeAttribute(, .removeAttributeNS(,
//    .removeAttributeNode(, .toggleAttribute(;
//  - adding, moving or removing nodes: .append( (except on a name ending in
//    params or Params, a URL's search params), .appendChild(, .prepend(,
//    .before(, .after(, .insertBefore(, .insertAdjacentHTML,
//    .insertAdjacentElement, .insertAdjacentText, .moveBefore(, .remove(,
//    .removeChild(, .replaceChild(, .replaceChildren(, .replaceWith(,
//    .attachShadow(, .setHTML(, .setHTMLUnsafe(, .insertNode(,
//    .deleteContents(, .extractContents(, .surroundContents(, .reset(,
//    document.write(, .writeln(, .open(, .close(, execCommand;
//  - navigation: an assignment to location or to any location.<part>,
//    location.href, .assign, .replace, .reload(, history.pushState,
//    .replaceState, .back, .forward, .go, navigation.navigate, .reload,
//    .back, .forward, .traverseTo (and .src, .srcdoc, .href, .action above);
//  - windows and dialogs: open(, close(, stop(, print(, alert(, confirm(,
//    prompt( on their own or after window., self., top., parent. or
//    globalThis.; .show(, .showModal(, .showPopover(, .togglePopover(;
//  - cookie, storage and messaging: an assignment to document.cookie,
//    cookieStore, localStorage and sessionStorage .setItem(, .removeItem(,
//    .clear( or an assignment to any of their keys, indexedDB, caches,
//    BroadcastChannel, .postMessage(;
//  - .call(, .apply(, Reflect., new Function and eval, which could reach any
//    of these another way.
// The next test puts a line using each of these into a real probe and
// expects it caught, and holds read-only lines to passing: an assignment
// never matches a comparison (==, ===, =>). A text check does not see a name
// built at run time, a property reached with brackets or a write through an
// API not listed here, so a person reviewing a change to these functions
// still checks the rule.
const ASSIGN = String.raw`\s*(?:\*\*|<<|>>>?|\?\?|\|\||&&|[-+*/%&|^])?=(?![=>])`;
const READ_ONLY = new RegExp([
  String.raw`\bclick\b|\bsubmit\b|requestSubmit|dispatchEvent|\.focus\b|\.blur\(|scrollIntoView|\bscroll(?:To|By)?\(`,
  String.raw`\.(?:value|checked|selected|selectedIndex|files|textContent|innerText|outerText|innerHTML|outerHTML|nodeValue|className|classList|style|hidden|disabled|contentEditable|src|srcdoc|href|action)${ASSIGN}`,
  String.raw`\bdocument\.(?:title|designMode|body)${ASSIGN}|\.style\.[\w$]+${ASSIGN}|\.style\.(?:setProperty|removeProperty|cssText)\b|\.classList\.(?:add|remove|toggle|replace)\(|\.dataset\.[\w$]+${ASSIGN}`,
  String.raw`\.(?:setAttribute|setAttributeNS|setAttributeNode|setAttributeNodeNS|removeAttribute|removeAttributeNS|removeAttributeNode|toggleAttribute)\(`,
  String.raw`(?<![Pp]arams)\.append\(|\.insertAdjacent(?:HTML|Element|Text)\b|\.(?:appendChild|prepend|before|after|insertBefore|moveBefore|remove|removeChild|replaceChild|replaceChildren|replaceWith|attachShadow|setHTML|setHTMLUnsafe|insertNode|deleteContents|extractContents|surroundContents|reset)\(`,
  String.raw`\bdocument\.(?:write|writeln|open|close)\(|\bexecCommand\b`,
  String.raw`location\.(?:href|assign|replace)|(?<!\b(?:const|let|var)\s+)\blocation${ASSIGN}|\blocation\.[\w$]+${ASSIGN}|\.reload\(|\bhistory\.(?:pushState|replaceState|back|forward|go)\b|\bnavigation\.(?:navigate|reload|back|forward|traverseTo)\b`,
  String.raw`\b(?:window|self|top|parent|globalThis)\.(?:open|close|stop|print|alert|confirm|prompt)\b|(?<![\w$.])(?:open|close|stop|print|alert|confirm|prompt)\(|\.(?:show|showModal|showPopover|togglePopover)\(`,
  String.raw`\bdocument\.cookie${ASSIGN}|\bcookieStore\b|\b(?:localStorage|sessionStorage)\.(?:setItem|removeItem|clear)\(|\b(?:localStorage|sessionStorage)\.[\w$]+${ASSIGN}|\bindexedDB\b|\bcaches\b|\bBroadcastChannel\b|\.postMessage\(`,
  String.raw`\.call\(|\.apply\(|Reflect\.|new Function|\beval\b`,
].join('|'));
// The text of injected code with its comments taken out, trailing // ones
// too (stripComments, test/helpers.js), so a word in a comment ("open(",
// "remove(") neither trips the guard nor hides anything.
const codeOf = (src) => stripComments(src, { trailing: true });

test('the dealer-tab read-only guard catches every spelling it names, and lets comparisons through', () => {
  const caught = [
    // clicks, events, focus, scrolling
    'el.click();', "form['submit']();", 'form.submit();', 'form.requestSubmit();', "el.dispatchEvent(new Event('change'));", 'el.focus();', 'el.blur();',
    'el.scrollIntoView();', 'scroll(0, 1);', 'scrollTo(0, 0);', 'window.scrollBy(0, 1);',
    // assignments
    "input.value = 'x';", "input.value ??= 'x';", 'box.checked = true;', 'opt.selected = true;', 'sel.selectedIndex = 2;', 'input.files = list;',
    "el.textContent = '';", "document.body.textContent = '';", "el.innerText += 'x';", "el.outerText = '';", "el.innerHTML = '';", "el.outerHTML = '';",
    "text.nodeValue = 'x';", "el.className = 'x';", "el.classList = 'x';", "el.style = 'display:none';", 'el.hidden = true;', 'btn.disabled = false;',
    "el.contentEditable = 'true';", "frame.src = '/x';", "frame.srcdoc = '<p>';", "link.href = '/x';", "form.action = '/x';",
    "el.style.display = 'none';", "el.dataset.lc = '1';", "document.title = 'x';", "document.designMode = 'on';", 'document.body = el;',
    "el.style.setProperty('color', 'red');", "el.style.removeProperty('color');", "el.style.cssText = '';",
    "el.classList.add('x');", "el.classList.remove('x');", "el.classList.toggle('x');", "el.classList.replace('a', 'b');",
    // attributes
    "el.setAttribute('a', 'b');", "el.setAttributeNS(null, 'a', 'b');", 'el.setAttributeNode(attr);', 'el.setAttributeNodeNS(attr);',
    "el.removeAttribute('a');", "el.removeAttributeNS(null, 'a');", 'el.removeAttributeNode(attr);', "el.toggleAttribute('a');",
    // nodes
    'el.append(child);', 'form.append(input);', 'document.body.append(el);', 'document.body.appendChild(el);', 'el.prepend(x);', 'el.before(x);', 'el.after(x);',
    'parent.insertBefore(a, b);', "el.insertAdjacentHTML('beforeend', '<b>');", "el.insertAdjacentElement('afterend', x);", "el.insertAdjacentText('afterend', 'x');",
    'parent.moveBefore(a, b);', 'el.remove();', 'parent.removeChild(el);', 'parent.replaceChild(a, b);', 'el.replaceChildren();', 'el.replaceWith(x);',
    "el.attachShadow({ mode: 'open' });", "el.setHTML('<b>');", "el.setHTMLUnsafe('<b>');", 'range.insertNode(el);', 'range.deleteContents();',
    'range.extractContents();', 'range.surroundContents(el);', 'box.form && box.form.reset();', "document.write('<p>');", "document.writeln('<p>');",
    'document.open();', 'document.close();', "document.execCommand('bold');",
    // navigation
    "location = '/x';", 'window.location = u;', "document.location = '/z';", 'location.href = u;', 'location.assign(u);', 'location.replace(u);',
    "location.hash = '#x';", "location.search += '&a=1';", 'location.reload();', 'top.location.reload(true);', "history.pushState({}, '', '/y');",
    "history.replaceState({}, '', '/y');", 'history.back();', 'history.forward();', 'history.go(-1);', "navigation.navigate('/n');", 'navigation.reload();',
    'navigation.back();', 'navigation.forward();', "navigation.traverseTo('k');",
    // windows and dialogs
    "open('/x');", "window.open('/x');", 'close();', 'window.close();', 'self.close();', 'stop();', 'window.stop();', 'print();', 'window.print();',
    "alert('hi');", "top.alert('hi');", "confirm('ok?');", "window.confirm('ok?');", "prompt('x');", "parent.prompt('x');", "globalThis.open('/x');",
    'dialog.show();', 'dialog.showModal();', 'el.showPopover();', 'el.togglePopover();',
    // cookie, storage, messaging
    "document.cookie = 'lc=1';", "cookieStore.set('a', 'b');", "localStorage.setItem('a', '1');", "sessionStorage.removeItem('a');", 'sessionStorage.clear();',
    "localStorage.lc = '1';", "indexedDB.open('x');", "caches.open('x');", "new BroadcastChannel('x');", 'window.postMessage({ go: 1 }, "*");',
    // another way round
    'fn.call(el);', 'fn.apply(el, []);', "Reflect.set(el, 'value', 'x');", "new Function('x')();", "eval('x');",
  ];
  const free = [
    'if (location === u) return null;', "const on = box.checked === true;", 'const picked = opt.selected == true;', 'const t = document.title;',
    'const here = location.origin + location.pathname;', 'const text = el.textContent.trim();', 'if (el.hidden !== false) return null;',
    "const url = new URL('/x', location.origin);", "params.append('page', '2');", "url.searchParams.append('page', '2');",
    'const keep = (location) => location.origin;', "const location = window.location.origin;", "const ok = el.innerText.length >= 3;",
    "const shown = el.style.display !== 'none';", 'if (a.href == b.href) return a;', 'const pic = img.src || img.currentSrc;', 'const opened = isOpen(x);',
  ];
  // each one put into a copy of a real injected function, the way a later edit would land
  const host = codeOf(String(ADAPTERS[ADAPTERS.length - 1].probeInPage));
  const at = host.indexOf('{') + 1;
  assert.ok(!READ_ONLY.test(host), 'the host function itself only reads');
  for (const line of caught) assert.ok(READ_ONLY.test(host.slice(0, at) + line + host.slice(at)), `the guard misses: ${line}`);
  for (const line of free) assert.ok(!READ_ONLY.test(host.slice(0, at) + line + host.slice(at)), `the guard refuses read-only code: ${line}`);
  // a comment is not code: a word in one neither trips the guard nor counts
  assert.ok(!READ_ONLY.test(codeOf("function f() {\n  const a = 1; // never open( or remove( anything\n  return a;\n}")));
});

test('the dealer-site scan reaches the dealer tab only through the neutral probe and each adapter\'s own read-only probe and search', () => {
  // the wizard, the popup and the post-time re-check all go through scanRunner.js
  const runner = read('../extension/src/scanRunner.js');
  const injections = (runner.match(/executeScript\(/g) || []).length;
  const known = (runner.match(/func: (probeSiteInPage|adapter\.probeInPage|adapter\.searchInPage)\b/g) || []).length;
  assert.ok(injections === 3 && injections === known, `scanRunner.js may inject only the neutral probe and the adapters' probe and search (${injections} vs ${known})`);
  assert.ok(!/files:\s*\[|chrome\.debugger|tabs\.sendMessage/.test(runner), 'no other way into a page');
  assert.ok(String(probeSiteInPage).length > 50);
  assert.ok(!READ_ONLY.test(codeOf(String(probeSiteInPage))), 'scan.js probeSiteInPage must only read the page');
  assert.ok(!READ_ONLY.test(codeOf(readFileSync(new URL('../extension/src/scan.js', import.meta.url), 'utf8'))), 'nor anything else in scan.js');
  assert.ok(ADAPTERS.length >= 1);
  for (const adapter of ADAPTERS) {
    for (const name of ['probeInPage', 'searchInPage']) {
      const src = codeOf(String(adapter[name]));
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
