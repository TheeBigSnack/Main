// End-to-end test of the DealerOn and Dealer.com readers against two mock
// dealership websites (test/e2e/mock-platform-sites.mjs) whose used list
// pages draw their cars from JSON the page's own script asks for:
//   DealerOn: the popup scans (the probe finds the list request the page
//   made, the scan pages through it by "pt") -> Ready to post holds the six
//   used cars at the dealer's price, the 13-mile car waits on Needs a look ->
//   Post fills the mock Marketplace form with every photo from the car's own
//   page and the test clicks Publish as the salesperson would -> day 2: the
//   service worker's rescan finds the sold car's page answering 404 and the
//   other posted car's price drop.
//   Dealer.com: the same scan paging by "start" -> the sold car's page
//   answers 410 and goes on To do.
//
// The real facebook.com is never automated, and no real dealer website is
// read. Run: node test/e2e/platforms.e2e.mjs (npm run test:e2e runs every flow)

import { chromium } from 'playwright';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startMockPlatformSite, PLATFORM_LOT, DEALER_NAMES } from './mock-platform-sites.mjs';
import { startMockMarketplace } from './mock-marketplace.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const shots = join(root, 'test/e2e/screenshots');
mkdirSync(shots, { recursive: true });

// Test copy of the extension: it may script the local mock servers and nothing else.
const extDir = mkdtempSync(join(tmpdir(), 'lot-sync-ext-'));
cpSync(join(root, 'extension'), extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
manifest.permissions = manifest.permissions.filter((p) => p !== 'sidePanel');
delete manifest.side_panel;
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const sites = { dealerOn: await startMockPlatformSite('dealerOn'), dealerCom: await startMockPlatformSite('dealerCom') };
const market = await startMockMarketplace();
const originOf = (kind) => `http://127.0.0.1:${sites[kind].address().port}`;
const LIST = { dealerOn: '/searchused.aspx', dealerCom: '/used-inventory/index.htm' };
const marketOrigin = `http://127.0.0.1:${market.address().port}`;
const profileDir = mkdtempSync(join(tmpdir(), 'lot-sync-profile-platforms-'));
const context = await chromium.launchPersistentContext(profileDir, {
  channel: process.env.LOTSYNC_E2E_CHANNEL || 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  viewport: { width: 760, height: 900 },
});

const [sold, dropped, ...rest] = PLATFORM_LOT;
const lowMiles = PLATFORM_LOT[PLATFORM_LOT.length - 1];
const usual = PLATFORM_LOT.filter((c) => c !== lowMiles);
const errors = [];
let panelRef = null;
let popupRef = null;
const watch = (p) => {
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  p.on('pageerror', (e) => errors.push(String(e)));
  return p;
};
const control = async (kind, path) => (await fetch(originOf(kind) + path)).text();
const requests = async (kind) => JSON.parse(await control(kind, '/requests'));
const publishCount = async () => (await fetch(`${marketOrigin}/publish-count`)).text();

try {
  const ext = await context.newPage();
  await ext.goto('chrome://extensions');
  const extensionId = await ext.evaluate(async () => (await chrome.management.getAll()).find((e) => e.name === 'Lot Sync').id);
  await ext.close();
  const extUrl = (file) => `chrome-extension://${extensionId}/${file}`;

  const setup = await context.newPage();
  await setup.goto(extUrl('sidepanel.html'));
  await setup.evaluate(async ({ origins, marketOrigin, names }) => {
    const settings = (name) => ({
      myStores: [],
      basis: 'website',
      salesperson: { name: 'Alex', title: 'sales consultant' },
      dealer: { name, city: 'Springfield', state: 'OH', zip: '43215' },
      priceNote: 'Price includes the $490 doc fee; tax and tags extra.',
      dailyCap: 10,
      rewrite: { enabled: false, endpoint: '', key: '' },
    });
    await chrome.storage.local.set({
      [`settings:${origins.dealerOn}`]: settings(names.dealerOn),
      [`settings:${origins.dealerCom}`]: settings(names.dealerCom),
      devOverrides: {
        createUrl: `${marketOrigin}/marketplace/create/vehicle`,
        listingUrlPattern: `^${marketOrigin.replace(/\./g, '\\.')}/marketplace/item/(\\d+)`,
        afterPublishPatterns: [],
        settleMs: 200,
        recheckMs: 500,
      },
    });
  }, { origins: { dealerOn: originOf('dealerOn'), dealerCom: originOf('dealerCom') }, marketOrigin, names: DEALER_NAMES });
  await setup.close();

  const tab = (p, name) => p.locator(`.tabs button[data-view="${name}"]`);
  const vinsOf = (items) => (items || []).map((i) => i.vin);

  for (const kind of ['dealerOn', 'dealerCom']) {
    const origin = originOf(kind);
    const listUrl = origin + LIST[kind];
    const stored = (p, key) => p.evaluate(async (k) => (await chrome.storage.local.get(k))[k], `${key}:${origin}`);
    const rescanNow = (p) => p.evaluate((o) => chrome.runtime.sendMessage({ type: 'rescanNow', origin: o, reason: 'test' }), origin);
    async function openPopup() {
      const popup = watch(await context.newPage());
      popupRef = popup;
      await popup.addInitScript((url) => {
        const realQuery = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = async (q) => (q && q.active ? realQuery({ url }) : realQuery(q));
      }, listUrl);
      await popup.goto(extUrl('popup.html'));
      await popup.setViewportSize({ width: 720, height: 590 });
      return popup;
    }

    // ---- 1. The list page draws its cars from the JSON its script asks for ----
    const dealer = watch(await context.newPage());
    await dealer.goto(listUrl);
    await dealer.waitForSelector('.vehicle-card');
    const html = await (await fetch(listUrl)).text();
    assert.doesNotMatch(html, new RegExp(sold.vin), 'the list page itself carries no car: only its script does');
    await control(kind, '/requests?clear=1');

    // ---- 2. Scan ----
    let popup = await openPopup();
    await popup.click('#scan');
    await popup.waitForSelector('.banner.info', { timeout: 60000 });
    const asked = await requests(kind);
    const listCalls = asked.filter((r) => r.path.includes(kind === 'dealerOn' ? '/api/vhcliaa/' : '/getInventory'));
    assert.deepEqual(listCalls.map((r) => r.status), [200, 200], `${kind}: the two list pages, read once each`);
    assert.match(listCalls[1].path, kind === 'dealerOn' ? /[?&]pt=2\b/ : /[?&]start=4\b/);
    const ua = await dealer.evaluate(() => navigator.userAgent);
    assert.deepEqual([...new Set(asked.map((r) => r.ua))], [ua], "the browser's own user agent");
    assert.equal(asked.some((r) => /\/(?:used|certified)/.test(r.path)), false, 'no car page is read on a scan that finds every car in the list');

    const registry = await popup.evaluate(async () => (await chrome.storage.local.get('sites')).sites);
    assert.equal(registry[origin].adapter, kind);
    assert.ok(registry[origin].service.inventoryUrl.startsWith(origin), 'the list address the page itself called, on the website');
    const snap = await stored(popup, 'snapshot');
    for (const c of usual) {
      const e = snap.vehicles[c.vin];
      assert.equal(e && e.decision, 'ready', `${kind}: ${c.year} ${c.make} ${c.model} is ready`);
      assert.equal(e.price, c.base + c.fee, "the dealer's price with its fee: the default basis");
      assert.equal(e.priceBeforeFees, c.base, 'the base price beside it, for a dealer who chooses it');
    }
    assert.equal(snap.vehicles[lowMiles.vin].decision, 'review', 'a "Used" car with 13 miles waits for a person');
    assert.equal(await tab(popup, 'ready').locator('.count').textContent(), String(usual.length));
    await popup.screenshot({ path: join(shots, `platforms-${kind}-1-ready.png`) });

    // ---- 3. DealerOn: post one car through the side panel and the mock form ----
    if (kind === 'dealerOn') {
      await tab(popup, 'ready').click();
      await popup.click(`button[data-action="openPost"][data-vin="${sold.vin}"]`);
      await popup.waitForFunction(() => /side panel/i.test(document.querySelector('#status').textContent));
      await popup.close();
      const panel = watch(await context.newPage());
      panelRef = panel;
      await panel.goto(extUrl('sidepanel.html'));
      await panel.waitForSelector('#openForm', { timeout: 30000 });
      assert.match(await panel.textContent('#vehicle'), new RegExp(`\\$${(sold.base + sold.fee).toLocaleString('en-US')}`));
      assert.ok((await requests(kind)).some((r) => r.path.startsWith(`/used-Springfield-${sold.year}`) && r.status === 200), "the car's own page was read at post time");
      const [fb] = await Promise.all([context.waitForEvent('page'), panel.click('#openForm')]);
      watch(fb);
      await panel.waitForSelector('#confirmPosted', { timeout: 60000 });
      await panel.waitForSelector('#photos.done', { timeout: 30000 });
      const form = await fb.evaluate(() => ({ vin: document.getElementById('vin').value, price: document.getElementById('price').value, photos: document.getElementById('photoCount').textContent }));
      assert.deepEqual(form, { vin: sold.vin, price: (sold.base + sold.fee).toLocaleString('en-US'), photos: `${sold.photos} photos` }, "every photo from the car's own page, not the list's one thumbnail");
      assert.equal(await publishCount(), '0', 'the extension must not publish');
      await fb.click('#publish'); // the person
      await panel.waitForSelector('#detected', { timeout: 15000 });
      await panel.click('#confirmPosted');
      await panel.waitForSelector('#done');
      await panel.close();
      panelRef = null;
      popup = await openPopup();
    }
    // the second car was listed by hand
    await tab(popup, 'ready').click();
    await popup.click(`button[data-action="post"][data-vin="${dropped.vin}"]`);
    await popup.waitForSelector(`button[data-action="unpost"][data-vin="${dropped.vin}"]`);
    if (kind === 'dealerCom') {
      await popup.click(`button[data-action="post"][data-vin="${sold.vin}"]`);
      await popup.waitForSelector(`button[data-action="unpost"][data-vin="${sold.vin}"]`);
    }

    // ---- 4. Day 2: the first car sells, the second drops $1,000; the worker rescans ----
    await control(kind, '/scenario?name=day2');
    await control(kind, '/requests?clear=1');
    const r = await rescanNow(popup);
    assert.equal(r.ok, true, JSON.stringify(r));
    const goneStatus = kind === 'dealerOn' ? 404 : 410;
    assert.ok((await requests(kind)).some((q) => q.status === goneStatus), `the sold car's page answered ${goneStatus}`);
    const diff = await stored(popup, 'diff');
    assert.deepEqual(diff.takeDown.map((t) => [t.vin, t.why]), [[sold.vin, 'gone']]);
    assert.deepEqual(diff.priceUpdates.map((p) => [p.vin, p.from, p.to]), [[dropped.vin, dropped.base + dropped.fee, dropped.base - 1000 + dropped.fee]]);
    assert.deepEqual(vinsOf(diff.needsALook), []);
    await popup.close();
    popup = await openPopup();
    assert.match(await popup.textContent('.panel'), /Take down\s*1[\s\S]*Gone from the website/);
    await popup.screenshot({ path: join(shots, `platforms-${kind}-2-todo.png`), fullPage: true });
    await popup.close();
    await dealer.close();
  }

  assert.equal(await publishCount(), '1', "only the person's one click");
  assert.equal(rest.length > 0, true);
  assert.deepEqual(errors, [], 'no console errors');
  console.log('DealerOn and Dealer.com E2E passed. Screenshots in test/e2e/screenshots/');
} catch (e) {
  for (const [name, p] of [['Panel', panelRef], ['Popup', popupRef]]) {
    if (p && !p.isClosed()) {
      console.error(`${name} text:`, (await p.textContent('body').catch(() => '')).replace(/\s+/g, ' ').slice(0, 800));
      await p.screenshot({ path: join(shots, `platforms-failure-${name.toLowerCase()}.png`), fullPage: true }).catch(() => {});
    }
  }
  for (const kind of Object.keys(sites)) console.error(`Requests to the ${kind} mock:`, JSON.stringify(await requests(kind).catch(() => [])).slice(0, 2000));
  console.error('Console errors:', errors);
  throw e;
} finally {
  await context.close();
  for (const d of [profileDir, extDir]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { /* every run makes its own folders */ } }
  for (const s of Object.values(sites)) s.close();
  market.close();
}
