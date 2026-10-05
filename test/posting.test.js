import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { capStatus, postsToday, DEFAULT_DAILY_CAP } from '../extension/src/cap.js';
import { markPosted } from '../extension/src/rescan.js';
import { buildListingData } from '../extension/src/listingData.js';
import { FORM_MAP, DEV_OVERRIDE_KEYS, applyOverrides } from '../extension/facebook/formMap.js';
import { ADAPTERS } from '../extension/adapters/index.js';
import { probeSiteInPage } from '../extension/src/scan.js';
import { snapshot, fixtures, stripComments, commentStripperBlindSpots, strippedSourceFiles, moduleScopeNames, freeIdentifiers, stripStrings, callArguments } from './helpers.js';

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
    basis: 'beforeFees',
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

// The form map is held to a list of what it may contain, not to a list of
// words it may not: its top-level keys exactly, each field's keys, kinds and
// listing values, and then every pattern the finder compiles from a field
// (its name patterns, and its label, which the finder tries as a second
// chance) and every option wording it chooses from, run against the action
// buttons Facebook draws around a listing, in the languages the form comes
// in. A pattern that fits "Next", "Update" or "Publicar" would hand the fill
// code one of those buttons.
const FORM_MAP_KEYS = ['version', 'verifiedAgainstFacebook', 'createUrl', 'listingUrlPattern', 'afterPublishPatterns', 'yourListingsUrl', 'settleMs', 'recheckMs', 'fileInput', 'photoLimitDefault', 'photoLimitTextPatterns', 'fields', 'neverFill'];
const FIELD_KEYS = ['key', 'label', 'kind', 'name', 'options', 'optional'];
const FIELD_KINDS = ['text', 'textarea', 'typeahead', 'choice', 'checkbox', 'either'];
const LISTING_FIELDS = Object.keys(buildListingData({}).fields);
const ACTION_WORDINGS = [
  'Publish', 'Publish listing', 'Publicar', 'Publicar anuncio', 'Next', 'Next step', 'Siguiente', 'Update', 'Update listing', 'Actualizar',
  'Post', 'Post listing', 'Save draft', 'Save', 'Guardar borrador', 'Guardar', 'Delete', 'Delete listing', 'Eliminar', 'Eliminar publicación',
  'Mark as sold', 'Mark as available', 'Marcar como vendido', 'Submit', 'Enviar', 'Share', 'Compartir', 'Boost listing', 'Renew listing',
  'Continue', 'Continuar', 'Done', 'Listo', 'Confirm', 'Confirmar', 'Send', 'List item', 'Sell', 'Vender',
];
// Action verbs that no part of a field (pattern, label, option) may hold as a word.
const ACTION_WORDS = /\b(publish\w*|publicar|update\w*|actualizar|delete\w*|eliminar|sold|vendido|submit\w*|enviar|next|siguiente|post|posting|draft|borrador|share|compartir|boost|renew|confirm\w*|confirmar|send)\b/i;
const normWords = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
// The fits the option model allows, each by name. "Car" is the vehicle
// type's last wording, tried only after "Car/Truck", "Car/truck" and "Car or
// truck" found nothing, and after no option equals "car" or starts with it.
// It sits inside "Publicar" (Publish in Spanish) and "Marcar como vendido"
// (Mark as sold): buttons on the form and on a published listing, while
// pickOption reads only the option and menu item roles (fillForm.js OPTIONS,
// held to that below) of the list that opened from the vehicle type field.
const OPTION_FITS_ALLOWED = { car: ['publicar', 'publicar anuncio', 'marcar como vendido'] };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function formMapProblems(map) {
  const problems = [];
  const keys = Object.keys(map);
  if (JSON.stringify(keys) !== JSON.stringify(FORM_MAP_KEYS)) problems.push(`top-level keys are ${keys.join(', ')}`);
  if (!/^input\[type="file"\]$/.test(map.fileInput)) problems.push(`fileInput is ${map.fileInput}`);
  const seen = new Set();
  for (const f of [...(map.fields || []), ...(map.neverFill || []).map((n) => ({ ...n, never: true }))]) {
    const where = f.never ? `neverFill ${f.key || '?'}` : `field ${f.key}`;
    if (!f.never) {
      for (const k of Object.keys(f)) if (!FIELD_KEYS.includes(k)) problems.push(`${where} has a key ${k}`);
      if (!LISTING_FIELDS.includes(f.key)) problems.push(`${where} is not a listing value (listingData.js)`);
      if (seen.has(f.key)) problems.push(`${where} appears twice`);
      seen.add(f.key);
      if (!FIELD_KINDS.includes(f.kind)) problems.push(`${where} has kind ${f.kind}`);
    }
    // what the finder compiles: each name pattern, and the label as a whole-word second chance
    const res = [];
    for (const p of Array.isArray(f.name) ? f.name : [f.name]) {
      try { res.push([p, new RegExp(p, 'i')]); } catch (e) { problems.push(`${where} has a pattern that does not compile: ${p}`); }
    }
    if (!f.never && typeof f.label === 'string') res.push([`label ${f.label}`, new RegExp('\\b' + escapeRe(f.label) + '\\b', 'i')]);
    if (f.never) continue; // a fenced-off name may well name an action: it keeps the finder away from it
    for (const [src, re] of res) {
      for (const action of ACTION_WORDINGS) if (re.test(normWords(action))) problems.push(`${where}: ${src} fits "${action}"`);
      if (ACTION_WORDS.test(src)) problems.push(`${where}: ${src} names an action`);
    }
    // an option is chosen by its wording as fillForm.js pickOption does:
    // equal, then a prefix, then anywhere inside what the popup shows
    // (includes), so a wording fits every action wording that holds it
    for (const wordings of Object.values(f.options || {})) {
      for (const w of wordings) {
        const nw = normWords(w);
        if (ACTION_WORDS.test(nw)) problems.push(`${where}: option "${w}" names an action`);
        for (const action of ACTION_WORDINGS) {
          const na = normWords(action);
          if (na.includes(nw) && !(OPTION_FITS_ALLOWED[nw] || []).includes(na)) problems.push(`${where}: option "${w}" fits "${action}"`);
        }
      }
    }
  }
  // and the tripwire on every string anywhere in the map
  const strings = [];
  (function walk(x) {
    if (typeof x === 'string') strings.push(x.toLowerCase());
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  })(map);
  for (const word of ['publish', 'publicar', 'submit', 'delete', 'sold', 'update', 'button', 'aria-label']) {
    if (strings.some((s) => s.includes(word))) problems.push(`a value mentions "${word}"`);
  }
  return problems;
}

test('the form map holds only known keys and fields, and nothing in it fits Publish, Next, Update, Delete or Mark as sold in any language the form comes in', () => {
  assert.deepEqual(formMapProblems(FORM_MAP), []);
  // the premise of the one allowed fit: pickOption reads options and menu items only, never a button,
  // and "Car" is the vehicle type's last wording
  const fill = read('../extension/facebook/fillForm.js');
  assert.match(fill, /const OPTIONS = '\[role="option"\], \[role="menuitem"\], \[role="menuitemradio"\], \[role="menuitemcheckbox"\]';/);
  assert.match(fill, /let i = labels\.findIndex\(\(t\) => t === w\);\n\s*if \(i === -1\) i = labels\.findIndex\(\(t\) => t\.startsWith\(w\)\);\n\s*if \(i === -1\) i = labels\.findIndex\(\(t\) => t\.includes\(w\)\);/, 'pickOption: equal, then a prefix, then anywhere inside, as the model says');
  assert.deepEqual(FORM_MAP.fields.find((f) => f.key === 'vehicleType').options.car_truck.slice(-1), ['Car']);
  // the check itself: each way an action could get into the map is caught
  const field = (patch) => ({ ...FORM_MAP, fields: [...FORM_MAP.fields, patch] });
  const price = FORM_MAP.fields.find((f) => f.key === 'price');
  const withPrice = (patch) => ({ ...FORM_MAP, fields: FORM_MAP.fields.map((f) => (f === price ? { ...f, ...patch } : f)) });
  const choice = FORM_MAP.fields.find((f) => f.key === 'bodyStyle');
  const planted = {
    'a field for the Next button': field({ key: 'confirm', label: 'Next', kind: 'choice', name: ['^next\\b', '^update\\b', '^publicar\\b'] }),
    'a top-level selector': { ...FORM_MAP, nextStep: '[aria-label="Next"]' },
    'a top-level finder': { ...FORM_MAP, finish: { name: ['^(p.blish|publicar|update|post|next)\\b'] } },
    'an extra pattern that fits Update': withPrice({ name: ['^price\\b', '^update\\b'] }),
    'a pattern written to dodge words': withPrice({ name: ['^price\\b', '^p.bli'] }),
    'a Spanish Publish': withPrice({ name: ['^price\\b', '^pub'] }),
    'a label that names an action': withPrice({ label: 'Update' }),
    'a pattern that fits anything': withPrice({ name: ['.*'] }),
    'an option wording that is an action': { ...FORM_MAP, fields: FORM_MAP.fields.map((f) => (f === choice ? { ...f, options: { ...f.options, SUV: ['SUV', 'Mark as sold'] } } : f)) },
    'an option that is the start of an action': { ...FORM_MAP, fields: FORM_MAP.fields.map((f) => (f === choice ? { ...f, options: { ...f.options, SUV: ['Sig'] } } : f)) },
    'an option inside Update': { ...FORM_MAP, fields: FORM_MAP.fields.map((f) => (f === choice ? { ...f, options: { ...f.options, SUV: ['pdate'] } } : f)) },
    'an option inside Publicar': { ...FORM_MAP, fields: FORM_MAP.fields.map((f) => (f === choice ? { ...f, options: { ...f.options, SUV: ['ublicar'] } } : f)) },
    'the allowed Car fit on another field': { ...FORM_MAP, fields: FORM_MAP.fields.map((f) => (f === choice ? { ...f, options: { ...f.options, SUV: ['car como'] } } : f)) },
    'a field key the listing never fills': field({ key: 'action', label: 'Vehicle type extra', kind: 'text', name: ['^zzz\\b'] }),
    'a field with an extra key': withPrice({ selector: '#price' }),
    'a field of an unknown kind': withPrice({ kind: 'button' }),
    'a file input that is a button': { ...FORM_MAP, fileInput: 'button' },
  };
  for (const [what, map] of Object.entries(planted)) assert.ok(formMapProblems(map).length, `${what} is caught`);
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
  // every map the panel uses is formMap.js's own or built from it with applyOverrides: none comes back from a saved post
  const flowFields = new Function(`return ${/const FLOW_FIELDS = (\[[^\]]*\]);/.exec(panel)[1]}`)();
  assert.ok(!flowFields.includes('map'), 'a saved post must not carry the form map (FLOW_FIELDS)');
  const assigned = [...panel.matchAll(/state\.map\s*=(?!=)\s*([^;\n]+)/g)].map((m) => m[1].trim());
  assert.ok(assigned.length >= 3, 'the panel builds its map when a form opens, an upkeep starts and a post comes back');
  for (const rhs of assigned) assert.ok(['FORM_MAP', 'applyOverrides(FORM_MAP, devOverrides)'].includes(rhs), `state.map = ${rhs}`);
  const inAssign = [...panel.matchAll(/Object\.assign\(state,[\s\S]*?\}\);/g)].flatMap((m) => [...m[0].matchAll(/\bmap:\s*([^,}\n]+)/g)].map((x) => x[1].trim()));
  for (const rhs of inAssign) assert.equal(rhs, 'FORM_MAP', `Object.assign(state, { map: ${rhs} })`);
  assert.equal((panel.match(/applyOverrides\(FORM_MAP, devOverrides\)/g) || []).length, 3);
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

// The first-run dry run (probeFormInPage) reports which fields the fill
// would find, so a maintainer fixes a name pattern only when it is wrong. It
// must look at the same controls for each kind of field as the fill
// (fillFormInPage): Make, Model and Location drawn as a dropdown or an
// editable box are filled, and the dry run must not list them as Not found.
// Each injected function keeps its own copy (they run self-contained in the
// page), so the two tables are compared here.
test('the dry run looks for each kind of field with the same controls the fill does', () => {
  const src = read('../extension/facebook/fillForm.js');
  const table = (fn) => {
    const body = src.slice(src.indexOf(`function ${fn}(`));
    const start = body.indexOf('const TEXT_INPUTS');
    const end = body.indexOf('};', body.indexOf('const KIND_SELECTORS')) + 2;
    assert.ok(start >= 0 && end > start, `${fn} has its selector table`);
    return new Function(`${body.slice(start, end)}\nreturn KIND_SELECTORS;`)();
  };
  const fill = table('fillFormInPage');
  const probe = table('probeFormInPage');
  assert.deepEqual(probe, fill);
  for (const kind of new Set(FORM_MAP.fields.map((f) => f.kind))) assert.ok(fill[kind], `the fill has controls for ${kind} fields`);
  assert.match(probe.typeahead, /\[role="combobox"\]/, 'a dropdown in a typeahead\'s place is found');
  assert.match(probe.typeahead, /\[contenteditable="true"\]/, 'so is an editable box');
});

// What these source checks prove: the usual ways to click, submit, press a
// key on or inject into a page in ordinary code are caught, and so are the
// common indirect ones (a method name built from pieces, .call, a stored
// event). They are a tripwire, not a proof: the e2e mock form
// (test/e2e/mock-marketplace.mjs) puts decoy Next, Post, Save draft, Update,
// Delete and Mark as sold controls beside its Publish button and the flows
// assert that no fill ever touched one.
// What a read-only function in the page may not do: assign to anything
// reached through a dot or brackets (a box's value, a checkbox's checked, a
// node's text, a dataset entry), step one with ++ or --, call a method that
// changes the page, its forms, focus, scroll, address or history, touch
// classes, styles or the page's storage and cookies, send anything, or call
// through call, apply, bind, Reflect, eval or Function. Nor may it call a
// method named in brackets (el['click'](), form[m]()), or assign to a
// property through destructuring or a for-of or for-in loop. Local variables
// may be assigned; nothing else may. Each line names what it caught.
const PAGE_MUTATIONS = [
  /[\w$\])]\s*\.\s*[\w$]+\s*(?:[-+*\/%|&^]|\*\*|\?\?|\|\||&&|<<|>>>?)?=(?![=>])/,
  /[\w$\])]\s*\[[^\]]*\]\s*(?:[-+*\/%|&^]|\*\*|\?\?|\|\||&&|<<|>>>?)?=(?![=>])/,
  /(\+\+|--)\s*[\w$]+\s*[.[]|[\w$\])]\s*\.\s*[\w$]+\s*(\+\+|--)/,
  /\.\s*(click|focus|blur|submit|requestSubmit|dispatchEvent|reset)\b/,
  /\.\s*(remove|append|prepend|appendChild|removeChild|replaceChild|replaceWith|replaceChildren|insertBefore|insertAdjacent\w*|before|after|setAttribute\w*|removeAttribute\w*|toggleAttribute|attachShadow|select|setSelectionRange|setRangeText|setCustomValidity|stepUp|stepDown|showPicker|showModal|show|close|open|togglePopover|showPopover|hidePopover|requestFullscreen|scrollIntoView\w*|scrollTo|scrollBy|write|writeln|execCommand|addEventListener|pushState|replaceState|assign|reload|add|toggle|setProperty|removeProperty|setPointerCapture|postMessage|sendBeacon)\s*\(/,
  /\bclassList\b|\.style\b|\bdataset\b|\bhistory\b|\bdocument\.cookie\b|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/,
  /\blocation\s*=(?!=)|\bwindow\.(open|stop|print)\s*\(|\b(alert|confirm|prompt|fetch)\s*\(|XMLHttpRequest|WebSocket|EventSource|\bObject\.(assign|defineProperty|defineProperties|setPrototypeOf)\b/,
  /\.call\b|\.apply\b|\.bind\b|\bReflect\b|\bFunction\b|\beval\b|\bimport\s*\(|\bset(Timeout|Interval)\s*\(\s*['"`]/,
  /[\w$\])]\s*\[[^\]]*\]\s*\(/,
  /\bfor\s*\(\s*(?:[{[]|[\w$]+\s*(?:\.|\[))/,
  /(?<!\b(?:const|let|var)\s*[{[][^;]*)[}\]]\s*=(?![=>])/,
];
const pageMutations = (code) => PAGE_MUTATIONS.map((re) => code.match(re)).filter(Boolean).map((m) => m[0].trim());

function fillCodeProblems(src) {
  const problems = [];
  const fail = (bad, why) => { if (bad) problems.push(why); };
  // the read-only probe and the listing reader must not act on the page at all
  const probe = src.slice(src.indexOf('function probeFormInPage'), src.indexOf('function fillPriceInPage'));
  fail(probe.length < 100 || pageMutations(probe).length > 0, 'probeFormInPage must be read-only');
  const reader = src.slice(src.indexOf('function readListingInPage'), src.indexOf('function attachPhotosInPage'));
  fail(reader.length < 100 || pageMutations(reader).length > 0, 'readListingInPage must be read-only');
  // the price filler touches one box and never clicks
  const pricer = src.slice(src.indexOf('function fillPriceInPage'), src.indexOf('function readListingInPage'));
  fail(pricer.length < 100 || /\.click\b/.test(pricer), 'fillPriceInPage must not click');
  // no submit by any spelling (form.submit(), requestSubmit, ['submit'], a submit button), and no Publish, Mark as sold or Delete
  fail(/submit|\bpublish\b|mark as sold|\bdelete\b/i.test(src), 'fillForm.js must not contain submit/publish/delete paths');
  // every click sits in one of three helpers, one click each: opening a
  // dropdown, choosing one of its options, ticking a checkbox the map names.
  // Anywhere else, .click in any form (a call, .click.call or .apply,
  // HTMLElement.prototype.click) fails, whatever the receiver is called.
  let rest = src;
  for (const helper of ['openDropdown', 'chooseOption', 'setCheckbox']) {
    const body = bodyOf(src, helper);
    fail(body.length < 50, `${helper} is missing`);
    fail((body.match(/\.click\b/g) || []).length !== 1, `${helper} must have exactly one click`);
    fail((body.match(/\.click\(\)/g) || []).length !== 1, `${helper}'s click must be a plain call`);
    rest = rest.replace(body, '');
  }
  fail(/\.click\b|\bclick\s*\(/.test(rest), 'fillForm.js clicks only inside openDropdown, chooseOption and setCheckbox');
  // no click synthesised as an event, and no Enter pressed (Enter commits a form)
  fail(/['"`]click['"`]/.test(src), 'fillForm.js must not dispatch a click event');
  fail(/['"`]Enter['"`]/.test(src), 'fillForm.js must not press Enter');
  // nothing called through a computed name (btn['cl' + 'ick']()), and no
  // apply, Reflect, eval or Function; .call only for the value setter, and no
  // prototype but the two input setters' (so no HTMLElement.prototype.click)
  fail(/\]\s*\(/.test(src), 'fillForm.js must not call through a computed name');
  fail(/\.apply\b|\bReflect\b|\bFunction\s*\(|\beval\b/.test(src), 'fillForm.js must not call through apply, Reflect, eval or Function');
  fail(/\.call\b/.test(src.replace(/\bdesc\.set\.call\(/g, '')), 'fillForm.js uses .call only for the value setter');
  fail(/prototype/.test(src.replace(/\bHTML(Input|TextArea)Element\.prototype\b/g, '')), 'fillForm.js reaches no prototype but the input setters\'');
  fail(/execCommand\((?!\s*'insertText')/.test(src), 'fillForm.js runs no editing command but insertText');
  // every event is one of the helpers' own: pointer and mouse presses, key
  // presses through key(), input and change; none dispatched from a variable
  for (const [ctor, count] of [['MouseEvent', 1], ['PointerEvent', 1], ['KeyboardEvent', 1]]) fail((src.match(new RegExp(`new ${ctor}\\(`, 'g')) || []).length !== count, `only the ${ctor} helper builds a ${ctor}`);
  fail(/new (?!(Mouse|Pointer|Keyboard)Event\(type\b|Event\('(input|change)'|InputEvent\('input')\w*Event\b/.test(src), 'fillForm.js builds only pointer, mouse, key, input and change events');
  fail(/dispatchEvent\((?!new (Mouse|Pointer|Keyboard|Input)?Event\()/.test(src), 'fillForm.js dispatches only events it builds in place');
  // each call's second argument, read with its parentheses balanced (callArguments): a first argument
  // with a call in it, such as key(control.closest('[role="button"]'), ' '), is read like any other
  const calls = (s, fn) => callArguments(s, fn).map((args) => args.slice(1).join(', '));
  for (const t of calls(src, 'mouse')) fail(!["'mousedown'", "'mouseup'"].includes(t), `mouse(…, ${t})`);
  for (const t of calls(src, 'pointer')) fail(!["'pointerdown'", "'pointerup'"].includes(t), `pointer(…, ${t})`);
  // keys: Escape and ArrowDown anywhere, Space only on the checkbox, a typed character only in typeText's box
  const checkbox = bodyOf(src, 'setCheckbox');
  const typing = bodyOf(src, 'typeText');
  fail(typing.length < 50, 'typeText is missing');
  for (const k of calls(checkbox, 'key')) fail(k !== "' '", `setCheckbox presses ${k}`);
  for (const k of calls(typing, 'key')) fail(k !== 'ch', `typeText presses ${k}`);
  for (const k of calls(src.replace(checkbox, '').replace(typing, ''), 'key')) fail(!["'Escape'", "'ArrowDown'"].includes(k), `fillForm.js presses ${k} outside setCheckbox and typeText`);
  return problems;
}

test('callArguments reads each call with its parentheses, brackets, braces and strings balanced', () => {
  assert.deepEqual(callArguments(`key(control.closest('[role="button"]'), ' ');`, 'key'), [[`control.closest('[role="button"]')`, "' '"]]);
  assert.deepEqual(callArguments("key([...a].find((b) => /x/.test(b, 1)), 'Escape', btn)", 'key'), [['[...a].find((b) => /x/.test(b, 1))', "'Escape'", 'btn']]);
  assert.deepEqual(callArguments("mouse({ a: 1, b: [2, 3] }, 'mouseup'); h.mouse(el, ',)')", 'mouse'), [['{ a: 1, b: [2, 3] }', "'mouseup'"], ['el', "',)'"]]);
  assert.deepEqual(callArguments('function key(el, k) {} keyboard(1); monkey(2); key()', 'key'), [[]]);
});

test('the fill code never submits a form, and clicks or presses keys only where its helpers say', () => {
  const src = read('../extension/facebook/fillForm.js');
  assert.deepEqual(fillCodeProblems(src), []);
  // the check itself: each way to reach an action button from the fill function is caught
  const plant = (code) => src.replace('return result;', `${code}\n  return result;`);
  assert.equal(plant('X'), src.replace('return result;', 'X\n  return result;'), 'the fill function ends in return result');
  const planted = {
    'HTMLElement.prototype.click': 'HTMLElement.prototype.click.call(btn);',
    'a click built from pieces': "btn['cl' + 'ick']();",
    'a click on a receiver named control': "const control = [...document.querySelectorAll('[role=button]')].find((b) => /^(next|post)$/i.test(b.textContent)); control.click();",
    'a submit built from pieces': "f['sub' + 'mit']();",
    'Enter on a focused button': "btn.focus(); key(btn, 'Enter');",
    'Space on a focused button': "btn.focus(); key(btn, ' ');",
    'a key named in a variable': 'const k = String.fromCharCode(13); key(btn, k);',
    'a stored event': "const ev = new MouseEvent(type, {}); btn.dispatchEvent(ev);",
    'a click event under another name': 'mouse(btn, kind);',
    'a pointer event of another kind': "pointer(btn, 'pointercancel');",
    'Space on a button found by a call': "key(control.closest('[role=\\\"button\\\"]'), ' ');",
    'Space on a button picked from a list': "key([...document.querySelectorAll('[role=\\\"button\\\"]')].find((b) => /next/i.test(b.textContent)), ' ');",
    'a mouse event on a button found by a call': "mouse(document.querySelector('[role=button]').closest('div'), kind);",
    'a key with a third argument': "key(el, 'Escape', btn);",
    'Space through an object holding the helper': "const h = { key }; h.key(btn, ' ');",
    'Reflect.apply': 'Reflect.apply(HTMLElement.prototype.focus, btn, []);',
    'a borrowed method': 'btn.focus.apply(btn);',
    'an editing command': "document.execCommand('delete');",
  };
  for (const [what, code] of Object.entries(planted)) assert.ok(fillCodeProblems(plant(code)).length, `${what} is caught`);
});

// The dry run's probe and upkeep's listing reader run on the person's own
// form and live listing: each is held to the read-only check above, and the
// check itself catches each way to change the page planted in either one.
test('the dry run and the listing reader only read the page: every way to change it is caught', () => {
  const src = read('../extension/facebook/fillForm.js');
  for (const [fn, next] of [['probeFormInPage', 'fillPriceInPage'], ['readListingInPage', 'attachPhotosInPage']]) {
    const body = src.slice(src.indexOf(`function ${fn}`), src.indexOf(`function ${next}`));
    assert.ok(body.length > 100, `${fn} is found`);
    assert.deepEqual(pageMutations(body), [], `${fn} only reads`);
  }
  const plants = {
    'ticking every checkbox': "for (const c of document.querySelectorAll('input[type=checkbox]')) c.checked = true;",
    'resetting the form': "for (const f of document.querySelectorAll('form')) f.reset();",
    'removing a node': "document.querySelector('form').remove();",
    'removing a child': 'document.body.removeChild(document.body.firstChild);',
    'rewriting text': "document.body.textContent = '';",
    'setting a value': "document.querySelector('input').value = '1';",
    'adding to a value': "document.querySelector('input').value += '9';",
    'setting a value by name': "document.querySelector('input')['value'] = '2';",
    'stepping an index': "document.querySelector('select').selectedIndex++;",
    'a dataset entry': "document.body.dataset.seen = '1';",
    'an attribute': "document.querySelector('input').setAttribute('value', '3');",
    'a class': "document.body.classList.add('x');",
    'a style': "document.body.style.display = 'none';",
    'Object.assign': "Object.assign(document.querySelector('input'), { value: '1' });",
    'a click': "document.querySelector('button').click();",
    'a stored click': "const c = document.querySelector('button').click; c();",
    'focus': "document.querySelector('input').focus();",
    'an event': "document.body.dispatchEvent(new Event('input'));",
    'scrolling': "document.body.scrollIntoView();",
    'going elsewhere': "location.assign('/');",
    'going elsewhere by assignment': "window.location = '/';",
    'history': 'history.back();',
    'the cookies': 'const c = document.cookie;',
    'sending a request': "fetch('/x');",
    'a borrowed method': "HTMLElement.prototype.click.call(document.body);",
    'a method named in brackets': "document.querySelector('button')['click']();",
    'a method held in a variable': "const f = document.querySelector('form'); const m = 'reset'; f[m]();",
    'a destructured assignment': "({ v: document.querySelector('input').value } = { v: '1' });",
    'an array destructured assignment': "[document.querySelector('input').value] = ['1'];",
    'a for-of loop target': "for (document.querySelector('input').value of ['1']) break;",
  };
  for (const [fn, at] of [['probeFormInPage', '  const found = [];'], ['readListingInPage', "  const body = chunks.join(' ');"]]) {
    assert.equal(src.split(at).length, 2, `${fn} has the planting point once`);
    for (const [what, code] of Object.entries(plants)) {
      const planted = src.replace(at, `${at}\n  ${code}`);
      assert.ok(fillCodeProblems(planted).includes(`${fn} must be read-only`), `${what} in ${fn} is caught`);
    }
  }
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
  // the side panel's fill, photos and dry run, and the read-only listing
  // reader a queue uses to see the new listing shows the car just published
  'sidepanel.js': { './facebook/fillForm.js': ['fillFormInPage', 'attachPhotosInPage', 'probeFormInPage', 'readListingInPage'] },
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
  // code that runs on pages by itself, registered at run time (the manifest's side is checked below)
  if (/\b(registerContentScripts|updateContentScripts|userScripts|declarativeContent|RequestContentScript)\b/.test(src)) problems.push(`${file}: registers code to run on pages`);
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
    'a content script registered from the worker': ['background.js', read('../extension/background.js') + "\nchrome.scripting.registerContentScripts([{ id: 'x', matches: [FB + '*'], js: ['facebook/x.js'] }]).catch(() => {});\n"],
    'a user script': ['background.js', read('../extension/background.js') + "\nchrome.userScripts.register([{ id: 'x', matches: [FB + '*'], js: [{ file: 'facebook/x.js' }] }]);\n"],
    'a declared content rule': ['background.js', read('../extension/background.js') + "\nnew chrome.declarativeContent.RequestContentScript({ js: ['facebook/x.js'] });\n"],
    'an injected file': ['upkeep.js', read('../extension/upkeep.js').replace('func: fillPriceInPage', "files: ['x.js'], func: fillPriceInPage")],
    'a function from elsewhere': ['upkeep.js', read('../extension/upkeep.js').replace('func: fillPriceInPage', 'func: somethingElse')],
  };
  for (const [what, [file, src]] of Object.entries(planted)) assert.ok(injectionProblems(file, src).length, `${what} is caught`);
});

// Every function those files inject runs in the page with nothing around it:
// Chrome sends only the function's own text. A constant or helper lifted out
// of fillFormInPage to the top of fillForm.js passes every other unit test
// and throws a ReferenceError on the real form. So no injected function may
// import, or name anything declared at its module's top level (the same
// check test/adapters.test.js runs on each adapter's probe and search).
// The names a module declares at its top level and the names a function
// body reaches come from test/helpers.js (moduleScopeNames, freeIdentifiers),
// the readers test/adapters.test.js uses on the adapters: every declarator of
// a declaration, destructured names and imports of every kind are seen.
function selfContainmentProblems(moduleSrc, fnSrc, name) {
  const problems = [];
  if (/\bimport\b|\brequire\s*\(/.test(stripStrings(stripComments(fnSrc, { trailing: true })))) problems.push(`${name} imports`);
  const outside = moduleScopeNames(moduleSrc);
  const reached = [...freeIdentifiers(fnSrc, name)].filter((id) => outside.has(id));
  if (reached.length) problems.push(`${name} reaches outside its own body for ${reached.join(', ')}`);
  return problems;
}

test('every function the extension injects into a page is self-contained: no import, nothing from its module around it', async () => {
  const checked = new Set(); // a function two files inject (the listing reader) is one function
  for (const [file, allowed] of Object.entries(INJECTORS)) {
    for (const [from, names] of Object.entries(allowed)) {
      const url = new URL(from, new URL('../extension/' + file, import.meta.url));
      const moduleSrc = readFileSync(url, 'utf8');
      const mod = await import(url);
      for (const name of names) {
        assert.equal(typeof mod[name], 'function', `${from} exports ${name}`);
        assert.deepEqual(selfContainmentProblems(moduleSrc, String(mod[name]), name), [], `${from} ${name}`);
        checked.add(`${url.pathname} ${name}`);
      }
    }
  }
  assert.equal(checked.size, 6, 'the five fillForm.js functions and the neutral site probe');
  // the check itself
  const fillSrc = readFileSync(new URL('../extension/facebook/fillForm.js', import.meta.url), 'utf8');
  const { fillFormInPage, readListingInPage } = await import('../extension/facebook/fillForm.js');
  const lifted = (fn, line) => String(fn).replace('{', `{\n  ${line}`);
  const planted = {
    'a constant lifted to the top of the module': [fillSrc + '\nconst FILL_HINT = 1;\n', lifted(fillFormInPage, 'void FILL_HINT;')],
    'a helper lifted to the top of the module': [fillSrc + '\nexport function norm2(s) { return s; }\n', lifted(readListingInPage, "norm2('x');")],
    'another injected function called from inside': [fillSrc, lifted(fillFormInPage, 'probeFormInPage(map);')],
    'an import': [fillSrc, lifted(fillFormInPage, "const m = await import('./formMap.js');")],
    'the second name of a declaration': [fillSrc + '\nconst FIRST = 1, SECOND_HINT = 2;\n', lifted(fillFormInPage, 'void SECOND_HINT;')],
    'a destructured name': [fillSrc + '\nconst { DESTRUCTURED_HINT } = globalThis;\n', lifted(fillFormInPage, 'void DESTRUCTURED_HINT;')],
    'a name used inside a template literal': [fillSrc + '\nconst TEMPLATE_HINT = 1;\n', lifted(fillFormInPage, 'const t = `${TEMPLATE_HINT}`;')],
  };
  for (const [what, [moduleSrc, fnSrc]] of Object.entries(planted)) assert.ok(selfContainmentProblems(moduleSrc, fnSrc, 'fillFormInPage').length, `${what} is caught`);
  // a planted name is caught by that name, not only by something else in the function
  for (const [what, [moduleSrc, fnSrc]] of Object.entries(planted)) {
    const hint = (fnSrc.match(/\b[A-Z]+_HINT\b/) || [])[0];
    if (hint) assert.match(selfContainmentProblems(moduleSrc, fnSrc, 'fillFormInPage').join(' '), new RegExp(`\\b${hint}\\b`), `${what}: ${hint} is named`);
  }
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
  for (const must of ['extension/wizard.js', 'extension/sidepanel.js', 'extension/src/rescanSchedule.js', 'extension/facebook/fillForm.js', 'extension/adapters/dealerInspire.js', 'backend/server.js', 'manager/manager.js', 'demo/demo.js']) assert.ok(files.includes(must), `${must} is not read`);
  // every extension file the injection guard above walks (extensionFiles) is among them
  for (const rel of extensionFiles()) assert.ok(files.includes('extension/' + rel), `extension/${rel} is not checked`);
  for (const rel of files) assert.deepEqual(commentStripperBlindSpots(readFileSync(new URL('../' + rel, import.meta.url), 'utf8')), [], `${rel}: the comment stripper would hide code here (write '/' + '*' instead)`);
});

test('the side panel reaches the Facebook tab only through the known fill functions and the read-only listing reader', () => {
  const src = read('../extension/sidepanel.js');
  const injections = (src.match(/executeScript\(/g) || []).length;
  const known = (src.match(/func: (fillFormInPage|attachPhotosInPage|probeFormInPage|readListingInPage)\b/g) || []).length;
  assert.ok(injections >= 4 && injections === known, `every executeScript must use one of the known fill functions or the listing reader (${injections} vs ${known})`);
  // the listing reader is read only once, by the queue's check of a new listing (readListingInPage is held read-only above)
  assert.equal((src.match(/func: readListingInPage\b/g) || []).length, 1);
  assert.match(bodyOf(src, 'confirmIfThisCar'), /func: readListingInPage, args: \[state\.map, LISTING_SIGNS, expect\]/);
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
  // nothing is filled or ticked off unless the page is this car's listing (onListing, tested in upkeep.test.js)
  assert.match(src, /const onTarget = onListing\(seen, \{ id, yourListingsUrl: map\.yourListingsUrl, namesakes \}\);/);
  assert.match(src, /const namesakes = id \? 0 : await namesakesNow\(\);/, 'other posted cars of this name are counted whenever no id is known');
  assert.doesNotMatch(src, /matchesId \|\| seen\.matchesName/, 'a name alone never stands in for a known listing id');
  assert.match(src, /if \(!onTarget\) return;/);
  // a sold/removed sign counts only when it appeared after the first read
  assert.match(src, /seen\.sold && !up\.baseline\.sold/);
  // the signs it watches for are text patterns, never selectors for controls
  const signs = read('../extension/facebook/listingSigns.js');
  assert.ok(!/button|role=|querySelector|\.click|\[data-/i.test(signs), 'listingSigns.js must describe text only');
});

// Outside fillForm.js, nothing the extension ships for Facebook (detectPost.js,
// listingSigns.js, formMap.js and any file added to facebook/ later) acts on a
// page, and neither does the service worker: no click, no synthetic event,
// no key, no submit, no focus. fillForm.js has its own, narrower check above.
const ACTS_ON_A_PAGE = /\.click\b|['"`]click['"`]|dispatchEvent|new (Mouse|Pointer|Keyboard|Input|Focus|Submit)?Event\b|\.submit\s*\(|requestSubmit|\.focus\s*\(|execCommand|executeScript|tabs\.sendMessage/;
test('the background worker and every Facebook file but the fill code never touch the page', () => {
  const files = extensionFiles().filter((f) => f === 'background.js' || (f.startsWith('facebook/') && f !== 'facebook/fillForm.js'));
  assert.ok(['background.js', 'facebook/detectPost.js', 'facebook/listingSigns.js', 'facebook/formMap.js'].every((f) => files.includes(f)), 'every file in facebook/ is read');
  for (const file of files) assert.ok(!ACTS_ON_A_PAGE.test(read('../extension/' + file)), `extension/${file} must not act on any page`);
  // the check itself: a new file in facebook/ that clicks or fires events is caught
  for (const code of [
    "setInterval(() => { for (const b of document.querySelectorAll('[role=button], button')) if (/^(Next|Publish|Post)$/.test(b.textContent.trim())) b.click(); }, 4000);",
    "export function done(b) { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); }",
    'export function done(f) { f.requestSubmit(); }',
    "export function done(b) { b.focus(); }",
  ]) assert.ok(ACTS_ON_A_PAGE.test(code), code);
});

// The e2e mock Marketplace's listing pages carry the real Mark as sold,
// Delete and Update buttons, and Facebook lands on a listing page after
// Publish. The mock logs every post of those forms, whatever listing it
// names, and every flow that publishes or does upkeep checks the log: empty
// for the create flows (with every listing as it was), exactly the test's
// own clicks for upkeep.
test('the mock Marketplace logs every Mark as sold, Delete and Update, and the flows check the log', async () => {
  const { startMockMarketplace, INITIAL_LISTINGS } = await import('./e2e/mock-marketplace.mjs');
  const server = await startMockMarketplace();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const json = async (path) => (await fetch(base + path)).json();
    assert.deepEqual(await json('/listing-actions'), []);
    assert.deepEqual(await json('/listing-state'), INITIAL_LISTINGS);
    const post = (path, body) => fetch(base + path, { method: 'POST', body, redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    await post('/marketplace/item/424242/delete');
    await post('/marketplace/edit/515151/save', 'price=30000');
    await post('/marketplace/item/434343/sold');
    await post('/marketplace/item/999999/sold'); // a listing the mock doesn't have is logged too
    assert.deepEqual(await json('/listing-actions'), ['delete 424242', 'save 515151', 'sold 434343', 'sold 999999']);
    assert.deepEqual(await json('/listing-state'), {
      ...INITIAL_LISTINGS,
      424242: { ...INITIAL_LISTINGS[424242], deleted: true },
      434343: { ...INITIAL_LISTINGS[434343], sold: true },
      515151: { ...INITIAL_LISTINGS[515151], price: 30000 },
    });
  } finally {
    server.close();
  }
  const flow = (name) => readFileSync(new URL(`./e2e/${name}.e2e.mjs`, import.meta.url), 'utf8');
  for (const name of ['post', 'queue', 'panel', 'standard']) {
    const src = flow(name);
    assert.match(src, /\/listing-actions`\)\)\.json\(\), \[\], 'nothing may mark sold, delete or update a listing but the person'\);/, `${name}: the log stays empty`);
    assert.match(src, /\/listing-state`\)\)\.json\(\), INITIAL_LISTINGS, 'every listing is as it was'\);/, `${name}: every listing as it was`);
    const end = src.slice(src.lastIndexOf("assert.deepEqual(errors, [], 'no console errors');") - 300);
    assert.match(end, /await publishCount\(\w*\)/, `${name}: the log is checked again at the end, after any late click`);
  }
  const upkeep = flow('upkeep');
  assert.match(upkeep, /listingActions\(\), \[\], 'the box is filled and nothing is saved: Update waits for the person'\);\s*assert\.deepEqual\(await listingState\(\), INITIAL_LISTINGS\);\s*await listing\.click\('#update'\); \/\/ the person saves/);
  assert.match(upkeep, /listingActions\(\), \['save 515151', 'sold 434343', 'sold 424242'\], "only the person's clicks, nothing later"\);/);
});

// Never the real facebook.com in tests: every end-to-end flow's copy of the
// extension may script only the local mock servers, and the flow's browser
// refuses any Facebook address, failing the flow if one was asked for (a
// test override of the form map that did not apply, say).
test('every end-to-end flow scripts only the local mocks and refuses the real Facebook', async () => {
  const { FACEBOOK_ADDRESS } = await import('./e2e/noFacebook.mjs');
  for (const url of ['https://www.facebook.com/marketplace/create/vehicle', 'https://facebook.com/', 'http://m.facebook.com/x', 'https://www.facebook.com:443/marketplace/you/selling', 'https://scontent.xx.fbcdn.net/v/photo.jpg', 'https://fb.com', 'https://www.messenger.com/t/1']) {
    assert.match(url, FACEBOOK_ADDRESS, url);
  }
  for (const url of ['http://127.0.0.1:5555/marketplace/create/vehicle', 'https://www.example-dealer.test/used-vehicles/', 'https://notfacebook.com/', 'https://www.example.test/?next=https://www.facebook.com/', 'https://facebook.com.example.test/']) {
    assert.doesNotMatch(url, FACEBOOK_ADDRESS, url);
  }
  const dir = new URL('./e2e/', import.meta.url);
  const flows = readdirSync(dir).filter((f) => f.endsWith('.e2e.mjs'));
  assert.ok(flows.length >= 8, 'the flows are found');
  for (const name of flows) {
    const src = readFileSync(new URL(name, dir), 'utf8');
    if (!/launchPersistentContext\(/.test(src)) continue;
    const perms = [...src.matchAll(/manifest\.host_permissions = (\[[^\]]*\]);/g)].map((m) => m[1]);
    assert.deepEqual(perms, ["['http://127.0.0.1/*']"], `${name}: the extension copy may script only the local mocks`);
    assert.match(src, /import \{ blockFacebook \} from '\.\/noFacebook\.mjs';/, `${name}: imports the Facebook block`);
    assert.match(src, /launchPersistentContext\([^;]*?\}\);\nconst facebook = await blockFacebook\(context\);/, `${name}: blocks Facebook before anything opens`);
    assert.match(src, /facebook\.assertNone\(\);\s*console\.log\('[^']*E2E passed/, `${name}: fails if Facebook was asked for`);
  }
});
