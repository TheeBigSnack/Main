// End-to-end test of listing upkeep: two cars are posted (with their listing
// links saved); the website then sells one and drops the other's price; the
// rescan puts both on the To do tab; "Open & update price" opens the MOCK
// listing, the test clicks Edit as the person would, the panel fills the
// new price, the test clicks Update, and the panel notices the new price and
// marks the item done. Along the way the tab is moved to another car's edit
// form and to another listing of the same year, make and model: nothing is
// filled there. The sold car's listing link is then forgotten (a car marked
// posted by hand), and a second unit of the same car at the same price is in
// the posted list: "Open listing" opens Your listings, where nothing is
// ticked off; the person opens the other unit's listing and marks it sold,
// and nothing is ticked off there either (its VIN is not this car's); the
// test opens the car's own listing and clicks Mark as sold, and the panel
// notices and marks it taken down. The mock logs every Update, Mark as sold
// and Delete posted to a listing: before each of the test's clicks as the
// person the log holds only the clicks it made before, and at the end exactly
// its three (one Update, two Mark as sold), with every listing in the state
// those clicks left.
//
// The real facebook.com is never automated. Run: npm run test:e2e:upkeep

import { chromium } from 'playwright';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startMockSite } from './mock-dealer-site.mjs';
import { startMockMarketplace, INITIAL_LISTINGS } from './mock-marketplace.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const shots = join(root, 'test/e2e/screenshots');
mkdirSync(shots, { recursive: true });

const extDir = mkdtempSync(join(tmpdir(), 'lot-sync-ext-')); // a fresh folder, so flows can run side by side
cpSync(join(root, 'extension'), extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
manifest.permissions = manifest.permissions.filter((p) => p !== 'sidePanel'); // no real side panel in tests
delete manifest.side_panel;
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const site = await startMockSite();
const market = await startMockMarketplace();
const siteUrl = `http://127.0.0.1:${site.address().port}/used-vehicles/`;
const origin = new URL(siteUrl).origin;
const marketOrigin = `http://127.0.0.1:${market.address().port}`;
const profileDir = mkdtempSync(join(tmpdir(), 'lot-sync-profile-upkeep-'));
const context = await chromium.launchPersistentContext(profileDir, {
  channel: process.env.LOTSYNC_E2E_CHANNEL || 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  viewport: { width: 760, height: 900 },
});

const errors = [];
let panelRef = null;
const watch = (p) => {
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  p.on('pageerror', (e) => errors.push(String(e)));
  return p;
};
const RAM = '1C6RR7FT0KS643289';
const WAGONEER = '1C4SJVDT7NS142834';
const RAM_TWIN = '1C6RR7FT0KS000434'; // a second unit of the Ram, same name and price (mock-marketplace.mjs listing 434343)

try {
  const ext = await context.newPage();
  await ext.goto('chrome://extensions');
  const extensionId = await ext.evaluate(async () => (await chrome.management.getAll()).find((e) => e.name === 'Lot Current').id);
  await ext.close();
  const extUrl = (file) => `chrome-extension://${extensionId}/${file}`;

  // Settings, two posted cars with their listing links, and the mock's addresses.
  const setup = await context.newPage();
  await setup.goto(extUrl('sidepanel.html'));
  await setup.evaluate(async ({ origin, marketOrigin, RAM, WAGONEER }) => {
    await chrome.storage.local.set({
      [`settings:${origin}`]: { myStores: [], basis: 'website', salesperson: { name: 'Roger', title: 'sales consultant' }, dealer: { name: 'Ron Lewis Chrysler Dodge Jeep Ram Waynesburg' }, dailyCap: 10, rewrite: { enabled: false } },
      [`posted:${origin}`]: {
        [RAM]: { name: '2019 Ram 1500 Classic Express', price: 27163, postedAt: '2026-09-26T21:00:00.000Z', listingUrl: `${marketOrigin}/marketplace/item/424242/` },
        [WAGONEER]: { name: '2022 Jeep Wagoneer Series III', price: 38383, postedAt: '2026-09-26T21:00:00.000Z', listingUrl: `${marketOrigin}/marketplace/item/515151/` },
      },
      devOverrides: { createUrl: `${marketOrigin}/marketplace/create/vehicle`, listingUrlPattern: `^${marketOrigin.replace(/\./g, '\\.')}/marketplace/item/(\\d+)`, afterPublishPatterns: [], yourListingsUrl: `${marketOrigin}/marketplace/you/selling`, settleMs: 200, recheckMs: 500 },
    });
  }, { origin, marketOrigin, RAM, WAGONEER });
  await setup.close();

  const dealer = await context.newPage();
  await dealer.goto(siteUrl);

  async function openPopup() {
    const popup = watch(await context.newPage());
    await popup.addInitScript((url) => {
      const realQuery = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (q) => (q && q.active ? realQuery({ url }) : realQuery(q));
    }, siteUrl);
    await popup.goto(extUrl('popup.html'));
    await popup.setViewportSize({ width: 720, height: 640 });
    return popup;
  }
  const tab = (p, name) => p.locator(`.tabs button[data-view="${name}"]`);
  const listingState = async () => (await dealer.request.get(`${marketOrigin}/listing-state`)).json();
  // every Update, Mark as sold and Delete posted to a listing, in order (mock-marketplace.mjs)
  const listingActions = async () => (await dealer.request.get(`${marketOrigin}/listing-actions`)).json();

  // ---- 1. Day 1 scan, then day 2: the Ram sells and the Wagoneer drops $1,500 ----
  let popup = await openPopup();
  await popup.click('#scan');
  await popup.waitForSelector('.banner.info');
  await dealer.request.get(`${origin}/scenario?name=day2`);
  await popup.click('#scan');
  await popup.waitForSelector('h3');
  const todo = await popup.textContent('.panel');
  assert.match(todo, /Take down\s*1[\s\S]*2019 Ram 1500 Classic Express/);
  assert.match(todo, /Update price\s*1[\s\S]*Wagoneer[\s\S]*\$38,383 → \$36,883/);
  assert.equal(await tab(popup, 'todo').locator('.count').textContent(), '2');
  await popup.screenshot({ path: join(shots, 'upkeep-1-todo.png'), fullPage: true });

  // ---- 2. Update the Wagoneer's price: open the listing, the person clicks Edit, Lot Current fills the price, the person clicks Update ----
  await popup.click('button[data-action="upkeep"][data-kind="price"]');
  await popup.waitForFunction(() => /side panel/i.test(document.querySelector('#status').textContent));
  await popup.close();
  const panel = watch(await context.newPage());
  panelRef = panel;
  const listingPromise = context.waitForEvent('page', { timeout: 30000 });
  await panel.goto(extUrl('sidepanel.html'));
  const listing = watch(await listingPromise);
  await listing.waitForLoadState();
  assert.match(listing.url(), /\/marketplace\/item\/515151\/$/, 'the saved listing link is opened');
  await panel.waitForSelector('#priceWaiting');
  assert.match(await panel.textContent('#priceWaiting'), /\$36,883/);
  // The person opens the WRONG car's edit form in that tab: nothing may be filled there.
  await listing.goto(`${marketOrigin}/marketplace/edit/424242/`);
  await panel.waitForFunction(() => /isn't showing the listing for 2022 Jeep Wagoneer/.test(document.querySelector('#upkeepNote')?.textContent || ''), null, { timeout: 10000 });
  await listing.waitForTimeout(3500);
  assert.equal(await listing.inputValue('#price'), '27163', "the other listing's price box is untouched");
  assert.equal(await panel.$('#priceFilled'), null);
  // ...nor in another listing of the same year, make and model (a Series II, not this Series III).
  await listing.goto(`${marketOrigin}/marketplace/edit/616161/`);
  await listing.waitForTimeout(3500);
  assert.equal(await listing.inputValue('#price'), '41500', "the other Wagoneer's price box is untouched");
  assert.equal(await panel.$('#priceFilled'), null);
  // Back to the right listing, then Edit: now it fills.
  await listing.goto(`${marketOrigin}/marketplace/item/515151/`);
  await panel.waitForFunction(() => !document.querySelector('#upkeepNote'), null, { timeout: 10000 });
  await listing.click('text=Edit listing'); // the person
  await panel.waitForSelector('#priceFilled', { timeout: 20000 });
  assert.equal(await listing.inputValue('#price'), '36883');
  await panel.screenshot({ path: join(shots, 'upkeep-2-price-filled.png') });
  assert.deepEqual(await listingActions(), [], 'the box is filled and nothing is saved: Update waits for the person');
  assert.deepEqual(await listingState(), INITIAL_LISTINGS);
  await listing.click('#update'); // the person saves
  await panel.waitForSelector('#upkeepDone', { timeout: 20000 });
  assert.match(await panel.textContent('#upkeepDone'), /now shows \$36,883/);
  assert.equal((await listingState())['515151'].price, 36883);
  assert.deepEqual(await listingActions(), ['save 515151'], "one Update, the person's");
  await panel.click('#upkeepClose');

  popup = await openPopup();
  assert.equal(await tab(popup, 'todo').locator('.count').textContent(), '1');
  assert.doesNotMatch(await popup.textContent('.panel'), /Update price/);
  await tab(popup, 'mine').click();
  assert.match(await popup.textContent('.panel'), /Wagoneer[\s\S]*Listed \$36,883/);

  // ---- 3. Take the Ram down, its listing link forgotten (as for a car marked posted by hand), with a second Ram of the same name and price posted too: Your listings opens, nothing is ticked off there or on the other Ram's listing; the person opens this Ram's listing and clicks Mark as sold; Lot Current notices ----
  await popup.evaluate(async ({ o, vin, twin }) => {
    const k = `posted:${o}`;
    const posted = (await chrome.storage.local.get(k))[k];
    delete posted[vin].listingUrl;
    posted[twin] = { name: '2019 Ram 1500 Classic Express', price: 27163, postedAt: '2026-09-26T21:00:00.000Z' };
    await chrome.storage.local.set({ [k]: posted });
  }, { o: origin, vin: RAM, twin: RAM_TWIN });
  await popup.close();
  popup = await openPopup();
  await tab(popup, 'todo').click();
  const listing2Promise = context.waitForEvent('page', { timeout: 30000 });
  await popup.click('button[data-action="upkeep"][data-kind="takeDown"]');
  await popup.waitForFunction(() => /side panel/i.test(document.querySelector('#status').textContent));
  await popup.close();
  const listing2 = watch(await listing2Promise);
  await listing2.waitForLoadState();
  assert.match(listing2.url(), /\/marketplace\/you\/selling$/, 'with no link, Your listings opens');
  await panel.waitForSelector('#takeDownWaiting');
  assert.equal(context.pages().filter((p) => /\/marketplace\/you\/selling/.test(p.url())).length, 1, 'the request is acted on once');
  await panel.waitForFunction(() => /Open its own listing page \(Lot Current looks for its full name, \$27,163 and its VIN, 1C6RR7FT0KS643289\)/.test(document.querySelector('#upkeepNote')?.textContent || ''), null, { timeout: 10000 });
  await listing2.waitForTimeout(3500);
  assert.ok(await panel.$('#takeDownWaiting'), 'nothing is ticked off on Your listings');
  // the person opens the OTHER Ram (same name, same price) and marks it sold: not this car's take-down
  await listing2.click('a[href="/marketplace/item/434343/"]');
  await listing2.waitForURL(/\/marketplace\/item\/434343\/$/);
  await panel.waitForFunction(() => /Another car you posted also has 2019 Ram 1500 Classic Express in its name.*VIN, 1C6RR7FT0KS643289, and this page doesn't/.test(document.querySelector('#upkeepNote')?.textContent || ''), null, { timeout: 10000 });
  assert.deepEqual(await listingActions(), ['save 515151'], 'nothing was marked sold or deleted on Your listings');
  await listing2.click('text=Mark as sold'); // the person, on the wrong Ram
  await listing2.waitForTimeout(3500);
  assert.equal((await listingState())['434343'].sold, true);
  assert.ok(await panel.$('#takeDownWaiting'), 'the other Ram marked sold ticks nothing off');
  await listing2.goto(`${marketOrigin}/marketplace/you/selling`);
  await listing2.click('a[href="/marketplace/item/424242/"]'); // the person opens the car's own listing
  await listing2.waitForURL(/\/marketplace\/item\/424242\/$/);
  await panel.waitForFunction(() => !document.querySelector('#upkeepNote'), null, { timeout: 10000 });
  // A listing page with a "Mark as sold" button, a "Sold" filter tab and
  // "Sold as-is" in its description must not read as sold.
  await listing2.waitForTimeout(3500);
  assert.ok(await panel.$('#takeDownWaiting'), 'still waiting for the person');
  assert.deepEqual(await listingActions(), ['save 515151', 'sold 434343'], "only the person's clicks so far");
  await listing2.click('text=Mark as sold'); // the person
  await panel.waitForSelector('#upkeepDone', { timeout: 20000 });
  assert.match(await panel.textContent('#upkeepDone'), /sold or removed/);
  assert.equal((await listingState())['424242'].sold, true);
  assert.deepEqual(await listingActions(), ['save 515151', 'sold 434343', 'sold 424242'], "one more Mark as sold, the person's");
  await panel.screenshot({ path: join(shots, 'upkeep-3-sold.png') });
  await panel.click('#upkeepClose');

  popup = await openPopup();
  assert.equal(await tab(popup, 'todo').locator('.count').textContent(), '0');
  assert.equal(await tab(popup, 'mine').locator('.count').textContent(), '2', 'the Wagoneer and the other Ram');
  assert.equal(await popup.evaluate(() => chrome.action.getBadgeText({})), '');

  // ---- 4. The Numbers tab (view id 'pilot'): both items were flagged by the day-2 scan and seen done on the listing by Lot Current ----
  await tab(popup, 'pilot').click();
  const pilotView = await popup.textContent('.panel');
  assert.match(pilotView, /Sold cars to take down\s*1\b/);
  assert.match(pilotView, /Price changes\s*1\b/);
  await popup.screenshot({ path: join(shots, 'upkeep-4-pilot.png'), fullPage: true });
  const pilot = await popup.evaluate(async (o) => (await chrome.storage.local.get(`pilot:${o}`))[`pilot:${o}`], origin);
  assert.deepEqual(pilot.flags.map((f) => [f.kind, f.how, typeof f.hours]).sort(), [['price', 'detected', 'number'], ['takeDown', 'detected', 'number']]);
  await popup.close();
  await panel.close();

  // at the end, only the person's three clicks, and every listing as they left it: none deleted, the other Wagoneer untouched
  assert.deepEqual(await listingActions(), ['save 515151', 'sold 434343', 'sold 424242'], "only the person's clicks, nothing later");
  assert.deepEqual(await listingState(), {
    ...INITIAL_LISTINGS,
    424242: { ...INITIAL_LISTINGS[424242], sold: true },
    434343: { ...INITIAL_LISTINGS[434343], sold: true },
    515151: { ...INITIAL_LISTINGS[515151], price: 36883 },
  });
  assert.deepEqual(errors, [], 'no console errors');
  console.log('Upkeep E2E passed. Screenshots in test/e2e/screenshots/');
} catch (e) {
  if (panelRef && !panelRef.isClosed()) {
    console.error('Panel text:', (await panelRef.textContent('#panel').catch(() => '')).replace(/\s+/g, ' ').slice(0, 600));
    await panelRef.screenshot({ path: join(shots, 'upkeep-failure.png'), fullPage: true }).catch(() => {});
  }
  console.error('Pages:', context.pages().map((p) => p.url()).join(' | '));
  console.error('Console errors:', errors);
  throw e;
} finally {
  await context.close();
  // leave nothing behind: the throwaway profile and the extension copy
  for (const d of [profileDir, extDir]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { /* still locked by the closing browser; every run makes its own folders, so a leftover does no harm */ } }
  site.close();
  market.close();
}
