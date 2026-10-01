// Storage hardening for wider use: every chrome.storage.local key the
// extension uses is named once, in src/storageKeys.js (the names existing
// installs hold; nothing is renamed), and every read-modify-write the popup,
// the side panel and the service worker share runs through src/storage.js
// under the key's lock. The first tests pin the names and the guard scans the
// shipped code for keys spelled anywhere else; the rest drive the lock helper.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { siteKeys, SITE_KEY_NAMES, GLOBAL_KEYS, SITES_KEY, REQUEST_KEYS, pilotKey } from '../extension/src/storageKeys.js';
import { SITES_KEY as RUNNER_SITES_KEY } from '../extension/src/scanRunner.js';
import { pilotKey as pilotKeyFromPilot } from '../extension/src/pilot.js';
import { withLock, updateKey, STORAGE_FULL, storageErrorText } from '../extension/src/storage.js';

const ORIGIN = 'https://example-dealer.test';

test('siteKeys names every per-website key as existing installs hold it; the globals and the re-exports agree', () => {
  assert.deepEqual(siteKeys(ORIGIN), {
    settings: `settings:${ORIGIN}`,
    snapshot: `snapshot:${ORIGIN}`,
    diff: `diff:${ORIGIN}`,
    posted: `posted:${ORIGIN}`,
    boilerplate: `boilerplate:${ORIGIN}`,
    queue: `postQueue:${ORIGIN}`,
    drafts: `drafts:${ORIGIN}`,
    wizard: `wizard:${ORIGIN}`,
    wizardDone: `wizardDone:${ORIGIN}`,
    flow: `postFlow:${ORIGIN}`,
    pilot: `pilot:${ORIGIN}`,
    sync: `sync:${ORIGIN}`,
  });
  assert.deepEqual(Object.keys(SITE_KEY_NAMES), ['settings', 'snapshot', 'diff', 'posted', 'boilerplate', 'queue', 'drafts', 'wizard', 'wizardDone', 'flow', 'pilot', 'sync']);
  assert.ok(Object.isFrozen(SITE_KEY_NAMES) && Object.isFrozen(GLOBAL_KEYS) && Object.isFrozen(REQUEST_KEYS));
  assert.deepEqual(GLOBAL_KEYS, { sites: 'sites', devOverrides: 'devOverrides', postRequest: 'postRequest', setupRequest: 'setupRequest', upkeepRequest: 'upkeepRequest', lastPostOrigin: 'lastPostOrigin', account: 'account' });
  assert.equal(SITES_KEY, 'sites');
  assert.deepEqual([...REQUEST_KEYS], ['postRequest', 'setupRequest', 'upkeepRequest']);
  assert.equal(pilotKey(ORIGIN), `pilot:${ORIGIN}`);
  assert.equal(RUNNER_SITES_KEY, SITES_KEY, 'scanRunner.js re-exports the same key');
  assert.equal(pilotKeyFromPilot, pilotKey, 'pilot.js re-exports the same function');
  // no per-website prefix collides with another, or with a global key
  const names = Object.values(SITE_KEY_NAMES);
  assert.equal(new Set(names).size, names.length);
  assert.ok(!names.some((n) => Object.values(GLOBAL_KEYS).includes(n)));
  assert.equal(siteKeys(undefined).posted, 'posted:', 'never throws; the caller checks the origin');
});

// Milestone 4's keys are documented when that work lands in HANDOFF.md.
const PENDING_DOCS = new Set();

test('the names are the documented ones (HANDOFF.md section 5.1)', () => {
  const handoff = readFileSync(new URL('../HANDOFF.md', import.meta.url), 'utf8');
  const section = handoff.slice(handoff.indexOf('### 5.1'), handoff.indexOf('### 5.2'));
  assert.ok(section.length > 500, 'section 5.1 is there');
  for (const name of Object.values(SITE_KEY_NAMES)) {
    if (PENDING_DOCS.has(name)) continue;
    assert.ok(section.includes('`' + name + ':<origin>`'), `HANDOFF.md 5.1 does not document ${name}:<origin>`);
  }
  for (const name of Object.values(GLOBAL_KEYS)) {
    if (PENDING_DOCS.has(name)) continue;
    assert.ok(section.includes('`' + name + '`'), `HANDOFF.md 5.1 does not document ${name}`);
  }
});

// ---------- the guard: no key spelled outside the module ----------

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const EXT = new URL('../extension/', import.meta.url);
const shipped = () => {
  const out = [];
  for (const dir of ['', 'src/', 'facebook/', 'adapters/']) for (const f of readdirSync(new URL(dir, EXT))) if (/\.js$/.test(f)) out.push(dir + f);
  return out;
};
// Template prefixes that are not storage keys: the data: URL the worker builds for a photo.
const URL_SCHEMES = new Set(['data', 'blob', 'http', 'https']);

function closingQuote(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === q) return j;
  }
  return src.length;
}

// The key literals handed to the storage calls: a quoted string as a whole
// argument or inside the array a get/remove takes, and the keys (bare, quoted
// or shorthand) at the top level of the object a set is given. Computed keys
// ([k.posted]), nested objects and function bodies are not literals.
function keyLiteralsIn(src) {
  const found = [];
  const re = /(?:chrome\.storage\.local\.(?:get|set|remove)|ownSet|ownRemove|updateKey)\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    const stack = []; // '{' an object literal, '[' an array, '(' parentheses, 'b' a block
    let expectKey = false;
    let last = '('; // the last significant character
    while (i < src.length) {
      const c = src[i];
      const depth = stack.length;
      const inObject = depth === 1 && stack[0] === '{';
      const inArray = depth === 1 && stack[0] === '[';
      if (c === "'" || c === '"' || c === '`') {
        const end = closingQuote(src, i);
        if (depth === 0 || inArray || (inObject && expectKey)) found.push(src.slice(i + 1, end));
        if (inObject) expectKey = false;
        i = end + 1;
        last = 'q';
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i;
        while (j < src.length && /[\w$]/.test(src[j])) j++;
        if (inObject && expectKey && src[i - 1] !== '.') found.push(src.slice(i, j));
        if (inObject) expectKey = false;
        i = j;
        last = 'w';
        continue;
      }
      if (c === '{') {
        // an object literal follows "(" or "," or "["; a block follows "=>" or ")"
        stack.push(last === '(' || last === ',' || last === '[' || last === ':' ? '{' : 'b');
        expectKey = stack.length === 1 && stack[0] === '{';
      } else if (c === '(' || c === '[') {
        if (inObject) expectKey = false;
        stack.push(c);
      } else if (c === ')' || c === ']' || c === '}') {
        if (!depth) break; // the call's closing parenthesis
        stack.pop();
      } else if (c === ',' && inObject) {
        expectKey = true;
      }
      if (!/\s/.test(c)) last = c;
      i++;
    }
  }
  return found;
}

test('the guard scanner finds the literals it is meant to and nothing else', () => {
  const sample = `
    chrome.storage.local.set({ sites: 1, [k.flow]: 2, 'lastPostOrigin': 3, nested: { origin: 4 }, ...rest });
    chrome.storage.local.get(['devOverrides', k.x]);
    chrome.storage.local.remove('postRequest');
    ownSet({ sites });
    updateKey('pilot:x', (cur) => { if (!cur) return undefined; return { ...cur, auto: true }; }, store);
    chrome.storage.local.get(GLOBAL_KEYS.sites);
    chrome.storage.local.set({ [GLOBAL_KEYS.postRequest]: { origin, at: Date.now() } });
    await updateKey(SITES_KEY, (current) => ({ ...current, [state.origin]: { auto: true } }), popupStorage);
    const devOverrides = (await chrome.storage.local.get(GLOBAL_KEYS.devOverrides))[GLOBAL_KEYS.devOverrides];
  `;
  assert.deepEqual(keyLiteralsIn(sample), ['sites', 'lastPostOrigin', 'nested', 'devOverrides', 'postRequest', 'sites', 'pilot:x']);
});

test('every storage key the shipped code names is produced by the key module or listed in GLOBAL_KEYS', () => {
  const allowed = new Set(Object.values(GLOBAL_KEYS));
  const files = shipped();
  assert.ok(files.includes('popup.js') && files.includes('src/storageKeys.js'));
  for (const rel of files) {
    if (rel === 'src/storageKeys.js') continue;
    const src = stripComments(readFileSync(new URL(rel, EXT), 'utf8'));
    // no per-website key is spelled here: neither `name:${origin}` nor `${name}:${origin}`
    const templates = [...src.matchAll(/`([A-Za-z]+):\$\{/g)].map((m) => m[1]).filter((p) => !URL_SCHEMES.has(p));
    assert.deepEqual(templates, [], `${rel} spells a storage key itself (${templates.join(', ')}): use siteKeys() from src/storageKeys.js`);
    assert.doesNotMatch(src, /\$\{[^}`]*\}:\$\{/, `${rel} builds a "<name>:<origin>" key itself`);
    for (const key of keyLiteralsIn(src)) assert.ok(allowed.has(key), `${rel} passes the key literal "${key}" to storage: name it in src/storageKeys.js`);
  }
  // the five files that used to spell their own keys now import the module,
  // and "Clear everything for this website" removes every key the module names
  for (const rel of ['popup.js', 'sidepanel.js', 'background.js', 'upkeep.js', 'wizard.js']) {
    assert.match(readFileSync(new URL(rel, EXT), 'utf8'), /from '\.\/src\/storageKeys\.js'/, `${rel} does not import src/storageKeys.js`);
  }
  assert.match(readFileSync(new URL('popup.js', EXT), 'utf8'), /ownRemove\(Object\.values\(siteKeys\(state\.origin\)\)\)/);
  // nothing asks Chrome for more room: the quota is handled, not raised
  assert.doesNotMatch(readFileSync(new URL('manifest.json', EXT), 'utf8'), /unlimitedStorage/);
});

// ---------- the lock helper ----------

// chrome.storage answers a tick later, in the order the calls were made (the
// shape test/pilot.test.js uses): two gets sent before either set both see
// the old value, and the second set wipes out the first.
function tickStorage() {
  const store = {};
  const later = (fn) => new Promise((resolve) => setTimeout(() => resolve(fn()), 0));
  return { store, get: (key) => later(() => ({ [key]: store[key] })), set: (obj) => later(() => { Object.assign(store, obj); }) };
}

// A promise-chain mutex per name: the shape navigator.locks.request has.
function chainLock(names = []) {
  const chains = new Map();
  return (name, fn) => {
    names.push(name);
    const run = (chains.get(name) || Promise.resolve()).then(fn);
    chains.set(name, run.catch(() => null));
    return run;
  };
}

test('updateKey, two callers at once: a lock that does nothing loses a write; the fallback mutex and an injected lock keep both', async () => {
  const key = siteKeys(ORIGIN).posted;
  const add = (storage, vin) => updateKey(key, (posted) => ({ ...(posted || {}), [vin]: { postedAt: 'now' } }), storage);

  const unlocked = { ...tickStorage(), lock: (name, fn) => fn() };
  await Promise.all([add(unlocked, 'A'), add(unlocked, 'B')]);
  assert.deepEqual(Object.keys(unlocked.store[key]), ['B'], 'both read the empty list; the second set overwrote the first');

  const fallback = tickStorage(); // no lock of its own, and no Web Locks under node: the promise-chain mutex in src/storage.js
  const [a, b] = await Promise.all([add(fallback, 'A'), add(fallback, 'B')]);
  assert.deepEqual(Object.keys(fallback.store[key]), ['A', 'B']);
  assert.deepEqual(Object.keys(a), ['A']);
  assert.deepEqual(Object.keys(b), ['A', 'B'], 'the second caller read the first one\'s write');

  const names = [];
  const injected = { ...tickStorage(), lock: chainLock(names) };
  await Promise.all([add(injected, 'A'), add(injected, 'B')]);
  assert.deepEqual(Object.keys(injected.store[key]), ['A', 'B']);
  assert.deepEqual(names, [key, key], 'locked on the key');
});

test('updateKey: an injected set does the writing (the popup\'s ownSet); undefined from the change writes nothing; a failure reaches the caller and does not block the next', async () => {
  const store = { [SITES_KEY]: { a: 1 } };
  const writes = [];
  const storage = { get: async (k) => ({ [k]: store[k] }), set: async (obj) => { writes.push(obj); Object.assign(store, obj); } };
  assert.deepEqual(await updateKey(SITES_KEY, (s) => ({ ...s, b: 2 }), storage), { a: 1, b: 2 });
  assert.deepEqual(writes, [{ [SITES_KEY]: { a: 1, b: 2 } }]);
  assert.equal(await updateKey(SITES_KEY, () => undefined, storage), undefined);
  assert.equal(await updateKey('missing', (v) => v, storage), undefined, 'nothing stored and nothing returned: nothing written');
  assert.equal(writes.length, 1);
  await assert.rejects(updateKey(SITES_KEY, () => { throw new Error('boom'); }, storage), /boom/);
  await assert.rejects(updateKey(SITES_KEY, (s) => s, { get: async () => { throw new Error('storage is gone'); }, set: async () => {} }), /storage is gone/);
  assert.deepEqual(await updateKey(SITES_KEY, (s) => s, storage), { a: 1, b: 2 }, 'the failures before did not block this caller');
  // the change may be async
  assert.deepEqual(await updateKey(SITES_KEY, async (s) => ({ ...s, c: 3 }), storage), { a: 1, b: 2, c: 3 });
});

test('withLock: the fallback mutex serialises holders of one name and lets other names run; in the browser it is a Web Lock', async () => {
  const log = [];
  const slow = (tag, ms) => () => new Promise((resolve) => setTimeout(() => { log.push(tag); resolve(tag); }, ms));
  const results = await Promise.all([withLock('x', slow('x1', 25)), withLock('x', slow('x2', 1)), withLock('y', slow('y1', 1))]);
  assert.deepEqual(results, ['x1', 'x2', 'y1']);
  assert.deepEqual(log, ['y1', 'x1', 'x2'], 'x2 waited for x1; y1 did not');
  await assert.rejects(withLock('x', async () => { throw new Error('nope'); }), /nope/);
  assert.equal(await withLock('x', async () => 'after'), 'after', 'a rejection is the caller\'s and does not block the next holder');
  assert.equal(await withLock('x', () => 'sync'), 'sync');

  const requested = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (name, fn) => { requested.push(name); return fn(); } } } });
  try {
    assert.equal(await withLock(SITES_KEY, async () => 'web'), 'web');
    assert.deepEqual(requested, [SITES_KEY]);
    const own = { get: async () => ({}), set: async () => {}, lock: async (name, fn) => fn() };
    await updateKey(SITES_KEY, () => ({}), own);
    assert.equal(requested.length, 1, 'an injected storage.lock is used before navigator.locks');
    await updateKey(SITES_KEY, () => ({}), { get: async () => ({}), set: async () => {} });
    assert.equal(requested.length, 2, 'without one, updateKey takes the Web Lock');
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original); else delete globalThis.navigator;
  }
});

test('a full storage is said in words the person can act on; any other failure keeps its own reason', () => {
  assert.equal(storageErrorText(new Error('QUOTA_BYTES quota exceeded')), STORAGE_FULL);
  assert.equal(STORAGE_FULL, "Couldn't save: Chrome's storage for Lot Current is full. Clear the numbers on the Numbers tab, or open an old dealership website and click Clear everything for this website in Settings.");
  assert.equal(storageErrorText(new Error('Extension context invalidated.')), "Couldn't save: Extension context invalidated.");
  assert.equal(storageErrorText('gone'), "Couldn't save: gone");
  assert.equal(storageErrorText(undefined), "Couldn't save: unknown error");
});
