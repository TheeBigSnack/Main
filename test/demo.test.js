// The test drive (demo/): sample data only, the real extension files
// untouched, the chrome.* stand-in complete, and no way to click Publish.
//   - no demo/ file names facebook.com or the pilot dealer;
//   - the sample lot's VINs pass extension/src/vin.js's checks, and the lot
//     has the shape the sandbox promises (ready cars, one without photos, one
//     without a price, two new ones, a day 2 that sells one, drops one price
//     and adds one);
//   - the shim defines every chrome.* member the extension code references;
//   - index.html carries the sandbox banner and loads nothing from elsewhere;
//   - the sandbox's own code has no selector for Publish, Update, Delete or
//     Mark as sold (non-negotiable 1 holds in the sandbox too).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { localVinCheck, checkVinFormat } from '../extension/src/vin.js';
import { normalizeVehicle } from '../extension/adapters/dealerInspireNormalize.js';
import { trimRecord } from '../extension/adapters/dealerInspire.js';
import { assessVehicle, DECISION } from '../extension/src/classify.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const demo = join(root, 'demo');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== 'screenshots') walk(full, out); }
    else out.push(full);
  }
  return out;
}
const demoFiles = walk(demo).filter((f) => /\.(js|mjs|html|css|json|svg|md)$/.test(f));

// The sample lot, loaded the way the fake site loads it (a plain script).
function loadInventory() {
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(read('demo/site/inventory.js'), ctx, { filename: 'inventory.js' });
  return ctx.window.LOT_SYNC_INVENTORY;
}
const vehiclesFor = (inv, scenario) => inv.records(scenario, 'http://sandbox.test/demo/site/').map((r) => normalizeVehicle(trimRecord(r, { fullRecords: true })));
const SETTINGS = { myStores: ['Example Motors Springfield'] };

test('demo/ names no real dealership and never facebook.com', () => {
  assert.ok(demoFiles.length >= 12, `expected the sandbox files, found ${demoFiles.length}`);
  const forbidden = /facebook\.com|Waynesburg|Ron Lewis|Cranberry|Pleasant Hills|15370|\bRoger\b|ronlewis|carscommerce/i;
  for (const file of demoFiles) {
    const hit = readFileSync(file, 'utf8').match(forbidden);
    assert.equal(hit, null, `${relative(root, file)} contains "${hit && hit[0]}"`);
  }
});

test('the sample VINs pass the extension\'s own VIN checks, and the lot has the promised shape', () => {
  const inv = loadInventory();
  const day1 = vehiclesFor(inv, 'day1');
  for (const v of [...day1, ...vehiclesFor(inv, 'day2')]) {
    assert.ok(checkVinFormat(v.vin).ok, `${v.vin}: ${checkVinFormat(v.vin).problems.join('; ')}`);
    assert.deepEqual(checkVinFormat(v.vin).notes, [], `${v.vin} has notes`);
    const c = localVinCheck(v);
    assert.ok(c.ok, `${v.name} ${v.vin}: ${c.problems.map((p) => p.detail).join('; ')}`);
    assert.ok(c.checks.every((k) => k.ok === true), `${v.vin}: every local check should agree (year and manufacturer), got ${JSON.stringify(c.checks.map((k) => k.ok))}`);
    assert.match(v.vin, /SAMPL/, 'the VINs are visibly samples');
  }
  const decisions = day1.map((v) => [v, assessVehicle(v, SETTINGS)]);
  const by = (d) => decisions.filter(([, a]) => a.decision === d);
  const used = day1.filter((v) => v.inventoryType !== 'New');
  assert.ok(used.length >= 6 && used.length <= 8, `${used.length} used cars`);
  assert.equal(by(DECISION.SKIP).length, 2, 'two new cars that must be skipped');
  assert.ok(by(DECISION.READY).length >= 3, 'several cars ready to post');
  assert.equal(decisions.filter(([, a]) => a.blockers.some((b) => b.code === 'no-photos')).length, 1, 'one without photos');
  assert.equal(decisions.filter(([, a]) => a.blockers.some((b) => b.code === 'no-price')).length, 1, 'one without a price');
  assert.equal(by(DECISION.REVIEW).length, 1, 'one that needs a look');
  assert.ok(decisions.some(([, a]) => a.blockers.some((b) => b.code === 'other-store')), 'one at another store');
  for (const v of day1) assert.ok(v.photos.every((u) => u.startsWith('http://sandbox.test/demo/site/photos/') && u.endsWith('.svg')), 'photos are the sandbox placeholders');
  for (const v of day1) for (const u of v.photos) assert.ok(existsSync(join(demo, 'site', u.slice('http://sandbox.test/demo/site/'.length))), `${u} exists`);

  // day 2: one gone, one price down, one added, the no-photos car got photos
  const day2 = vehiclesFor(inv, 'day2');
  const vins1 = new Set(day1.map((v) => v.vin));
  const vins2 = new Set(day2.map((v) => v.vin));
  assert.equal([...vins1].filter((v) => !vins2.has(v)).length, 1, 'one car sold');
  assert.equal([...vins2].filter((v) => !vins1.has(v)).length, 1, 'one arrival');
  const dropped = day2.filter((v) => { const b = day1.find((x) => x.vin === v.vin); return b && b.price && v.price && v.price < b.price; });
  assert.equal(dropped.length, 1, 'one price drop');
  assert.equal(dropped[0].price, day1.find((x) => x.vin === dropped[0].vin).price - inv.DAY2_DEFAULTS.drop);
  assert.ok(day2.find((v) => v.vin === inv.VINS.equinox).photoCount > 0, 'the car without photos got them');
  // and day 2 can be aimed at posted cars
  const aimed = vehiclesFor(inv, { name: 'day2', sold: inv.VINS.f150, dropped: inv.VINS.rav4 });
  assert.ok(!aimed.some((v) => v.vin === inv.VINS.f150), 'the posted car sold');
  assert.equal(aimed.find((v) => v.vin === inv.VINS.rav4).price, day1.find((v) => v.vin === inv.VINS.rav4).price - inv.DAY2_DEFAULTS.drop);
  assert.ok(aimed.some((v) => v.vin === inv.VINS.civic), 'the default sold car stays when another is named');
});

test('the shim defines every chrome.* member the extension code references', () => {
  const refs = new Set();
  for (const file of walk(join(root, 'extension')).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/\bchrome\.([a-zA-Z.]+)/g)) refs.add(m[1].replace(/\.+$/, ''));
  }
  assert.ok(refs.size >= 25, `found only ${refs.size} chrome.* references`);
  for (const must of ['storage.local.get', 'scripting.executeScript', 'tabs.create', 'runtime.sendMessage', 'sidePanel.open', 'action.setBadgeText']) assert.ok(refs.has(must), must);

  // the shim as a frame loads it: no DOM, a hub on the parent window
  const shimSrc = read('demo/chrome-shim.js');
  const hubCtx = vm.createContext({ window: {}, setTimeout, clearTimeout, console, structuredClone });
  vm.runInContext(shimSrc, hubCtx, { filename: 'chrome-shim.js' });
  const Shim = hubCtx.window.LotSyncShim;
  const hub = Shim.createHub({ manifest: JSON.parse(read('extension/manifest.json')), tabs: { list: () => [], get: () => null, create: () => ({ id: 2 }), update: () => ({}), remove: () => {}, windowOf: () => null } });
  const frameCtx = vm.createContext({ window: { parent: { __lotSyncHub: hub } }, setTimeout, clearTimeout, console, structuredClone });
  frameCtx.window.addEventListener = () => {};
  vm.runInContext(shimSrc, frameCtx, { filename: 'chrome-shim.js' });
  const chrome = frameCtx.window.chrome;
  assert.ok(chrome, 'the shim installs window.chrome inside a sandbox frame');
  for (const ref of [...refs].sort()) {
    let node = chrome;
    for (const part of ref.split('.')) {
      node = node === undefined || node === null ? undefined : node[part];
    }
    assert.notEqual(node, undefined, `chrome.${ref} is not defined by the shim`);
  }
  // and the file says what is stubbed
  for (const word of ['permissions', 'alarms', 'sidePanel', 'STUB']) assert.ok(shimSrc.includes(word), `the shim's stub list mentions ${word}`);
});

test('the shim\'s storage behaves like chrome.storage: JSON values, defaults, onChanged only for real changes', async () => {
  const ctx = vm.createContext({ window: {}, setTimeout, clearTimeout, console, structuredClone });
  vm.runInContext(read('demo/chrome-shim.js'), ctx, { filename: 'chrome-shim.js' });
  const hub = ctx.window.LotSyncShim.createHub({ manifest: { version: '0.0.0' } });
  const a = ctx.window.LotSyncShim.createChrome(hub, null);
  const b = ctx.window.LotSyncShim.createChrome(hub, null);
  const plain = async (p) => JSON.parse(JSON.stringify(await p)); // values come from the vm realm (another Object prototype)
  const seenA = [];
  const seenB = [];
  a.storage.onChanged.addListener((changes, area) => seenA.push([area, Object.keys(changes)]));
  b.storage.onChanged.addListener((changes, area) => seenB.push([area, Object.keys(changes)]));
  await a.storage.local.set({ x: { n: 1 }, y: [1, 2] });
  assert.deepEqual(await plain(b.storage.local.get(['x', 'y', 'z'])), { x: { n: 1 }, y: [1, 2] });
  assert.deepEqual(await plain(b.storage.local.get({ z: 'dflt', x: 0 })), { z: 'dflt', x: { n: 1 } });
  assert.deepEqual(await plain(b.storage.local.get('x')), { x: { n: 1 } });
  const all = await b.storage.local.get(null);
  assert.deepEqual(Object.keys(all).sort(), ['x', 'y']);
  await a.storage.local.set({ x: { n: 1 } }); // unchanged: no event, as in Chrome
  await a.storage.local.remove('y');
  await a.storage.sync.set({ profile: { name: 'Alex' } });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(JSON.parse(JSON.stringify(seenA)), [['local', ['x', 'y']], ['local', ['y']], ['sync', ['profile']]], 'the writer hears its own writes too');
  assert.deepEqual(JSON.parse(JSON.stringify(seenB)), JSON.parse(JSON.stringify(seenA)));
  assert.deepEqual(await plain(a.storage.sync.get('profile')), { profile: { name: 'Alex' } });
  // the messages: a listener in another frame answers; none at all rejects
  b.runtime.onMessage.addListener((msg, sender, sendResponse) => { if (msg.type === 'ping') { sendResponse({ ok: true, echo: msg.n }); return true; } return false; });
  assert.deepEqual(await plain(a.runtime.sendMessage({ type: 'ping', n: 7 })), { ok: true, echo: 7 });
  assert.equal(await a.runtime.sendMessage({ type: 'other' }), undefined);
  const c = ctx.window.LotSyncShim.createChrome(ctx.window.LotSyncShim.createHub({}), null);
  await assert.rejects(c.runtime.sendMessage({ type: 'ping' }), /Receiving end does not exist/);
  assert.equal(await a.permissions.contains({ origins: ['http://x/*'] }), true);
  assert.equal(await a.alarms.get('nothing'), null);
  assert.deepEqual(await plain(a.windows.getCurrent()), { id: 1, focused: true, type: 'normal', state: 'normal', incognito: false, alwaysOnTop: false });
});

test('index.html carries the sandbox banner and loads nothing from another site', () => {
  const html = read('demo/index.html');
  assert.match(html, /Sandbox with sample data\. Nothing here is Facebook or a real dealership\./);
  for (const file of demoFiles.filter((f) => /\.(html|js|mjs|css)$/.test(f))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
      assert.doesNotMatch(m[1], /^(https?:)?\/\//, `${relative(root, file)} loads ${m[1]} from another site`);
    }
    assert.doesNotMatch(src, /@import\s+url\(\s*["']?https?:/i, `${relative(root, file)} imports a remote stylesheet`);
  }
  // the popup and the panel are the extension's own files, mounted unchanged
  const demoJs = read('demo/demo.js');
  assert.match(demoJs, /mountPage\(\$\('popupFrame'\), 'popup\.html'\)/);
  assert.match(demoJs, /mountPage\(\$\('panelFrame'\), 'sidepanel\.html'\)/);
  assert.match(demoJs, /src="background\.js"/);
  assert.match(demoJs, /devOverrides/, 'the panel is pointed at the sandbox Marketplace through the test hook');
  assert.match(demoJs, /salesperson: \{ name: 'Alex'/);
  assert.match(demoJs, /dailyCap: 10/);
});

test('the sandbox\'s own code has no way to click Publish, Update, Delete or Mark as sold', () => {
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const rel of ['demo/chrome-shim.js', 'demo/demo.js']) {
    const code = strip(read(rel)).toLowerCase();
    for (const word of ['#publish', '#update', 'mark as sold', "'publish'", '"publish"', '.click(']) {
      assert.ok(!code.includes(word), `${rel} contains ${word}`);
    }
  }
  // the fake pages count the person's clicks so the drive can prove it
  assert.match(read('demo/marketplace/create.html'), /notePublishClick\(\)/);
  assert.match(read('demo/drive.mjs'), /publishClicks\(\), 0, 'the extension must not publish'/);
});
