// The test drive (demo/): sample data only, the real extension files
// untouched, the chrome.* stand-in complete, and no way to click Publish.
//   - no demo/ file names facebook.com or the pilot dealer;
//   - the sample lot's VINs pass extension/src/vin.js's checks, and the lot
//     has the shape the sandbox promises (ready cars, one without photos, one
//     without a price, two new ones, a day 2 that sells one, drops one price
//     and adds one);
//   - the second sample website (demo/site-standard/) reads as its promised
//     lot through the standard vehicle data reader, page by page, and is not
//     mistaken for the first kind of website;
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
import { parseVehiclePage } from '../extension/adapters/schemaOrgParse.js';
import { normalizeVehicle as normalizeStandard } from '../extension/adapters/schemaOrgNormalize.js';
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

// The second sample website, loaded the way its page loads it.
function loadStandard() {
  const ctx = vm.createContext({ window: {}, URL });
  vm.runInContext(read('demo/site-standard/inventory.js'), ctx, { filename: 'site-standard/inventory.js' });
  return ctx.window.LOT_SYNC_STANDARD;
}
const STD_BASE = 'http://sandbox.test/demo/site-standard/';

// The used lot read the way the standard vehicle data reader reads a
// website: the list pages one after another by rel=next, then each car's
// own page, whose own car is the one carrying that page's address.
function readStandard(std, scenario) {
  const site = std.hashSite(STD_BASE);
  const lists = [];
  const pages = [];
  for (let url = site.address('/used-vehicles/'); url && lists.length < 10;) {
    const answer = std.respond(url, scenario, site);
    assert.equal(answer.status, 200, url);
    const { vehicles, facts } = parseVehiclePage(answer.body, url);
    lists.push({ url, vins: vehicles.map((n) => n.vehicleIdentificationNumber) });
    for (const node of vehicles) if (!pages.includes(node.url)) pages.push(node.url);
    url = facts.next;
  }
  const cars = pages.map((url) => {
    const answer = std.respond(url, scenario, site);
    assert.equal(answer.status, 200, url);
    const { vehicles, facts } = parseVehiclePage(answer.body, url);
    const own = vehicles.filter((n) => n.url === url);
    assert.equal(own.length, 1, `${url} carries its own car once`);
    return normalizeStandard(own[0], { url, facts });
  });
  return { site, lists, pages, cars };
}

test('the second sample website reads as its promised lot through the standard vehicle data reader', () => {
  const std = loadStandard();
  for (const c of std.CARS) {
    assert.match(c.vin, /SAMPL/, 'the VINs are visibly samples');
    assert.ok(checkVinFormat(c.vin).ok, `${c.vin}: ${checkVinFormat(c.vin).problems.join('; ')}`);
    const check = localVinCheck({ vin: c.vin, year: c.year, make: c.make });
    assert.ok(check.ok, `${c.vin}: ${check.problems.map((p) => p.detail).join('; ')}`);
    // every check agrees; only a trailer maker is not in the local list of manufacturers
    for (const k of check.checks) assert.ok(k.ok === true || (c.kind === 'trailer' && k.code === 'make' && k.ok === null), `${c.vin} ${k.code}: ${k.detail}`);
  }

  // day 1: three list pages linked by rel=next, ten cars, each read from its own page
  const day1 = readStandard(std, 'day1');
  assert.equal(day1.lists.length, 3);
  assert.deepEqual(day1.lists.map((l) => l.vins.length), [4, 4, 2]);
  assert.equal(day1.cars.length, 10);
  const by = Object.fromEntries(day1.cars.map((v) => [std.CARS.find((c) => c.vin === v.vin).key, v]));
  const decide = (key) => assessVehicle(by[key], { myStores: [std.DEALER.name] });
  for (const key of ['civic', 'f150', 'escape', 'accord', 'sorento', 'rav4']) assert.equal(decide(key).decision, DECISION.READY, `${key}: ${decide(key).reason}`);
  // honest prices: the Malibu's markup says $14,995 but its page shows $15,495, so it has no price to post
  assert.equal(by.malibu.price, null);
  assert.deepEqual(decide('malibu').blockers.map((b) => b.code), ['no-price']);
  assert.deepEqual(decide('wrangler').blockers.map((b) => b.code), ['no-photos']);
  assert.equal(decide('outback').decision, DECISION.REVIEW, '12 miles on a used car');
  assert.ok(![DECISION.READY, DECISION.NOT_READY].includes(decide('trailer').decision), 'the trailer is never offered as a car');
  // the car pages' three kinds of markup read the same
  assert.deepEqual([by.f150.price, by.f150.mileage, by.f150.photoCount], [31495, 58112, 3], 'the @graph page');
  assert.deepEqual([by.escape.price, by.escape.mileage, by.escape.photoCount], [16495, 52110, 3], 'the microdata-only page');
  assert.deepEqual([by.sorento.price, by.sorento.mileage, by.sorento.photoCount], [25995, 35780, 3], 'the page with a carousel');
  for (const v of day1.cars) {
    assert.equal(v.location, std.DEALER.name);
    for (const u of v.photos) {
      assert.ok(u.startsWith(STD_BASE + 'photos/') && u.endsWith('.svg'), `${u} is a sandbox placeholder`);
      assert.ok(existsSync(join(demo, 'site-standard', u.slice(STD_BASE.length))), `${u} exists`);
    }
  }

  // the new car is on the website but not on the used list; the Sorento's carousel links to it
  const telluride = std.CARS.find((c) => c.key === 'telluride');
  const tellurideUrl = day1.site.address(std.vehicleRoute(telluride));
  assert.ok(!day1.pages.includes(tellurideUrl));
  const sorentoPage = std.respond(by.sorento.url, 'day1', day1.site).body;
  assert.ok(sorentoPage.includes(tellurideUrl), 'the carousel links to the new car');
  const tellurideRead = parseVehiclePage(std.respond(tellurideUrl, 'day1', day1.site).body, tellurideUrl);
  assert.equal(assessVehicle(normalizeStandard(tellurideRead.vehicles[0], { url: tellurideUrl, facts: tellurideRead.facts })).decision, DECISION.SKIP);

  // the sitemap lists the used cars' pages, and robots.txt names the sitemap
  const sitemap = std.respond(day1.site.address('/sitemap.xml'), 'day1', day1.site).body;
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  for (const u of day1.pages) assert.ok(locs.includes(u), `the sitemap lists ${u}`);
  assert.ok(!locs.includes(tellurideUrl));
  assert.match(std.respond('http://sandbox.test/robots.txt', 'day1', day1.site).body, new RegExp(`Sitemap: ${STD_BASE.replace(/\./g, '\\.')}sitemap\\.xml`));

  // day 2: the Accord sold, the Civic dropped $1,000, the Wrangler got photos, a Tucson arrived
  const day2 = readStandard(std, 'day2');
  const vins1 = day1.cars.map((v) => v.vin);
  const vins2 = day2.cars.map((v) => v.vin);
  assert.deepEqual(vins1.filter((v) => !vins2.includes(v)), [std.VINS.accord]);
  assert.deepEqual(vins2.filter((v) => !vins1.includes(v)), [std.VINS.tucson]);
  assert.equal(day2.cars.find((v) => v.vin === std.VINS.civic).price, 19995 - std.DAY2_DEFAULTS.drop);
  assert.equal(day2.cars.find((v) => v.vin === std.VINS.wrangler).photoCount, 3);
  // the sold car's page: a 404 by default, a 301 to the list, or a page saying it is no longer available
  const accordUrl = by.accord.url;
  assert.equal(std.respond(accordUrl, 'day2', day2.site).status, 404);
  const moved = std.respond(accordUrl, { name: 'day2', soldPage: '301' }, day2.site);
  assert.deepEqual([moved.status, moved.location], [301, day2.site.address('/used-vehicles/')]);
  const followed = std.respond(accordUrl, { name: 'day2', soldPage: '301' }, day2.site, { follow: true });
  assert.deepEqual([followed.status, followed.redirected, followed.url], [200, true, day2.site.address('/used-vehicles/')]);
  const gone = std.respond(accordUrl, { name: 'day2', soldPage: '200' }, day2.site);
  assert.equal(gone.status, 200);
  assert.match(gone.body, /no longer available/);
  assert.deepEqual(parseVehiclePage(gone.body, accordUrl).vehicles, [], 'nothing on it reads as the car');
  // and day 2 can be aimed at the cars a person posted
  const aimed = readStandard(std, { name: 'day2', sold: std.VINS.civic, dropped: std.VINS.accord });
  assert.ok(!aimed.cars.some((v) => v.vin === std.VINS.civic));
  assert.equal(aimed.cars.find((v) => v.vin === std.VINS.accord).price, 23495 - std.DAY2_DEFAULTS.drop);
});

test('the second sample website is its own kind of website, and switching to it resets the sandbox', () => {
  const page = read('demo/site-standard/index.html');
  // no inventory search service on it, so the first sample's adapter never claims it
  assert.doesNotMatch(page, /SEARCH_SERVICE|IDPSearchServiceHelper/);
  assert.match(page, /<script src="inventory\.js"><\/script>/);
  assert.match(page, /window\.fetch = function/, 'the page answers its own requests for its pages');
  assert.match(page, /'LOT_SYNC_SCENARIO'/, 'the sandbox can switch it to day 2');
  // the Node mock of the end-to-end flow serves the same dealership
  assert.match(read('test/e2e/mock-standard-site.mjs'), /demo\/site-standard\/inventory\.js/);

  const html = read('demo/index.html');
  assert.match(html, /<select id="siteChoice">[\s\S]*value="service"[\s\S]*value="standard"[\s\S]*<\/select>/);
  assert.match(html, /<script src="site-standard\/inventory\.js"><\/script>/);
  const demoJs = read('demo/demo.js');
  // storage is kept per website address and both samples share this page's, so a switch starts over and says so
  assert.match(demoJs, /async function switchSite\(id\) \{[\s\S]*await reset\(\);[\s\S]*so the sandbox was reset\./);
  assert.match(demoJs, /myStores: sample\.myStores/);
  assert.match(demoJs, /hub\.standardPage = /, "the service worker's stand-in answers the second sample's pages");
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
  assert.equal(await a.permissions.contains({ origins: ['http://x/*'] }), false, 'a host nobody granted');
  assert.equal(await a.alarms.get('nothing'), null);
  assert.deepEqual(await plain(a.windows.getCurrent()), { id: 1, focused: true, type: 'normal', state: 'normal', incognito: false, alwaysOnTop: false });
});

test('the shim\'s permissions behave like Chrome\'s: granted hosts only, a request answered as the test says, only from a click', async () => {
  const ctx = vm.createContext({ window: {}, setTimeout, clearTimeout, console, structuredClone, URL });
  vm.runInContext(read('demo/chrome-shim.js'), ctx, { filename: 'chrome-shim.js' });
  const Shim = ctx.window.LotSyncShim;
  const manifest = JSON.parse(read('extension/manifest.json'));
  const hub = Shim.createHub({ manifest, extensionBase: 'http://sandbox.test:8080/extension/' });
  const a = Shim.createChrome(hub, null);
  const plain = async (p) => JSON.parse(JSON.stringify(await p));
  const ANY = '/' + '*';
  const photoHost = 'https://photos.example-cdn.test' + ANY;
  // the manifest's hosts and the sandbox's own origin are granted; any other host is not
  for (const host of manifest.host_permissions) assert.equal(await a.permissions.contains({ origins: [host] }), true, host);
  assert.equal(await a.permissions.contains({ origins: ['http://sandbox.test:8080' + ANY] }), true, 'the sandbox reads its own sample website and photos');
  assert.equal(await a.permissions.contains({ origins: ['http://sandbox.test:9090' + ANY] }), false, 'another port is another origin');
  assert.equal(await a.permissions.contains({ origins: [photoHost] }), false);
  assert.equal(await a.permissions.contains({ permissions: ['storage'] }), true);
  assert.equal(await a.permissions.contains({ permissions: ['debugger'] }), false);
  assert.ok((await plain(a.permissions.getAll())).origins.includes('http://sandbox.test:8080' + ANY));
  // a no leaves it ungranted; a yes grants it, fires onAdded, and getAll lists it
  const added = [];
  a.permissions.onAdded.addListener((p) => added.push(p.origins));
  hub.permissionAnswer = false;
  assert.equal(await a.permissions.request({ origins: [photoHost] }), false);
  assert.equal(await a.permissions.contains({ origins: [photoHost] }), false);
  hub.permissionAnswer = true;
  assert.equal(await a.permissions.request({ origins: [photoHost] }), true);
  assert.equal(await a.permissions.contains({ origins: [photoHost] }), true);
  assert.ok((await plain(a.permissions.getAll())).origins.includes(photoHost));
  // nothing to ask when everything is granted already, whatever the answer would be
  hub.permissionAnswer = false;
  assert.equal(await a.permissions.request({ origins: [manifest.host_permissions[0], 'http://sandbox.test:8080' + ANY] }), true);
  assert.deepEqual(JSON.parse(JSON.stringify(hub.permissionRequests)), [[photoHost], [photoHost]], 'only the two real questions were asked');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(JSON.parse(JSON.stringify(added)), [[photoHost]]);
  // wildcard subdomains: *.cdn.test covers img.cdn.test, not xcdn.test
  hub.permissionAnswer = true;
  await a.permissions.request({ origins: ['https://*.cdn.test' + ANY] });
  assert.equal(await a.permissions.contains({ origins: ['https://img.cdn.test' + ANY] }), true);
  assert.equal(await a.permissions.contains({ origins: ['https://xcdn.test' + ANY] }), false);
  // a granted host can be removed again, a required one can't
  assert.equal(await a.permissions.remove({ origins: [photoHost] }), true);
  assert.equal(await a.permissions.contains({ origins: [photoHost] }), false);
  await assert.rejects(a.permissions.remove({ origins: [manifest.host_permissions[0]] }), /required/);
  // outside a click, Chrome refuses to ask; the frame's user activation says whether a click is under way
  const idle = Shim.createChrome(hub, { navigator: { userActivation: { isActive: false } }, addEventListener: () => {} });
  await assert.rejects(idle.permissions.request({ origins: [photoHost] }), /user gesture/);
  const clicked = Shim.createChrome(hub, { navigator: { userActivation: { isActive: true } }, addEventListener: () => {} });
  assert.equal(await clicked.permissions.request({ origins: [photoHost] }), true);
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
  for (const rel of ['demo/chrome-shim.js', 'demo/demo.js', 'demo/site-standard/inventory.js', 'demo/site-standard/index.html']) {
    const code = strip(read(rel)).toLowerCase();
    for (const word of ['#publish', '#update', 'mark as sold', "'publish'", '"publish"', '.click(']) {
      assert.ok(!code.includes(word), `${rel} contains ${word}`);
    }
  }
  // the fake pages count the person's clicks so the drive can prove it
  assert.match(read('demo/marketplace/create.html'), /notePublishClick\(\)/);
  assert.match(read('demo/drive.mjs'), /publishClicks\(\), 0, 'the extension must not publish'/);
});
