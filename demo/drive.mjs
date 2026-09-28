// Drives the Lot Sync test drive (demo/) the way a person would, in headless
// Chromium, and checks every step: scan, Post, the side panel's re-check and
// description, the sample Marketplace form filling itself, the person's own
// click on Publish (this script stands in for the person; the extension never
// clicks it, and the sample Marketplace counts the clicks to prove it),
// confirm, My listings, the Pilot tab, a queue of two, day 2 on the website,
// the rescan's To do items, the price update and the take-down through the
// side panel, the background rescan, and Reset.
//
// Run:  node demo/drive.mjs
// Needs the repo's Playwright (npm ci) and a Chromium: LOTSYNC_CHROME=<path>
// to a Chrome/Chromium binary, else the one Playwright installed
// (npx playwright install chromium). Screenshots go to demo/screenshots/.

import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startServer } from './serve.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const shots = join(root, 'demo/screenshots');
mkdirSync(shots, { recursive: true });
const shot = (page, name, opts = {}) => page.screenshot({ path: join(shots, name), ...opts });

const DEFAULT_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath = process.env.LOTSYNC_CHROME || (existsSync(DEFAULT_CHROME) ? DEFAULT_CHROME : undefined);

const server = await startServer({ port: 0 });
const url = `http://127.0.0.1:${server.address().port}/demo/`;
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() >= 400 && !/favicon\.ico$/.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`); });

const F150 = '1FTSAMPL9LE000001';
const RAV4 = '4T3SAMPL1ME000002';
const CIVIC = '2HGSAMPL6KE000003';

const popup = page.frameLocator('#popupFrame');
const panel = page.frameLocator('#panelFrame');
const tab = (id) => page.frameLocator(`iframe[data-tab-id="${id}"]`);
const tabFrame = async (id) => (await page.waitForSelector(`iframe[data-tab-id="${id}"]`, { timeout: 30000 })).contentFrame();
const popupTab = (name) => popup.locator(`.tabs button[data-view="${name}"]`);
const waitReady = () => page.waitForFunction(() => Boolean(document.body.dataset.ready), null, { timeout: 30000 });
// The popup closes when you click elsewhere, as in Chrome: open it before each visit.
async function openPopup() {
  if (await page.locator('#popupHost').isHidden()) await page.click('#lotSyncButton');
  await page.locator('#popupHost').waitFor({ state: 'visible' });
}
const publishClicks = () => page.evaluate(() => Number(sessionStorage.getItem('lotSyncSandbox.publishClicks') || 0));
const badge = () => page.locator('#badge').evaluate((el) => (el.hidden ? '' : el.textContent));
const text = (loc) => loc.textContent();

try {
  await page.goto(url);
  await waitReady();
  assert.match(await text(page.locator('#banner')), /Sandbox with sample data\. Nothing here is Facebook or a real dealership\./);
  assert.match(await text(page.locator('#url')), /\/demo\/site\/index\.html$/);
  await shot(page, 'drive-01-start.png');

  // ---- 1. Scan the sample website ----
  await openPopup();
  await popup.locator('#scan').click();
  await popup.locator('.banner.info').waitFor({ timeout: 20000 });
  assert.match(await text(popup.locator('.meta')), /8 used cars · 4 ready to post/);
  assert.equal(await text(popupTab('ready').locator('.count')), '4');
  assert.equal(await text(popupTab('notReady').locator('.count')), '2');
  assert.equal(await text(popupTab('otherStores').locator('.count')), '1');
  assert.equal(await text(popupTab('review').locator('.count')), '1');
  await popupTab('review').click();
  const review = await text(popup.locator('.panel'));
  assert.match(review, /Mazda CX-5[\s\S]*0 miles/);
  // the website's two new cars never enter the scan at all: the inventory request asks for used and certified used only
  assert.doesNotMatch(review, /Explorer|Camry/);
  await popupTab('ready').click();
  assert.match(await text(popup.locator('.rows')), /2019 Honda Civic EX[\s\S]*2020 Ford F-150 XLT[\s\S]*2021 Toyota RAV4 XLE[\s\S]*2022 Jeep Grand Cherokee Laredo/);
  await shot(page, 'drive-02-scanned-ready.png');

  // ---- 2. Post the F-150: the side panel re-checks it and writes the description ----
  await popup.locator(`button[data-action="openPost"][data-vin="${F150}"]`).click();
  await popup.locator('#status').filter({ hasText: /side panel/i }).waitFor();
  await panel.locator('#openForm').waitFor({ timeout: 20000 });
  const car = await text(panel.locator('#vehicle'));
  assert.match(car, /2020 Ford F-150 XLT/);
  assert.match(car, /\$32,995/);
  const draft = await panel.locator('#description').inputValue();
  assert.match(draft, /^2020 Ford F-150 XLT with 34,512 miles\./);
  assert.match(draft, /One owner according to the Carfax report\./);
  assert.match(draft, /pairs the 2\.7L EcoBoost V6/, "the car's own write-up is kept");
  assert.doesNotMatch(draft, /documentation fee/, 'the lot-wide disclaimer is stripped');
  assert.match(draft, /Price includes the \$250 doc fee; tax and tags extra\./);
  assert.match(draft, /I'm Alex, sales consultant at Example Motors\./);
  assert.match(draft, new RegExp(`VIN ${F150}\\.`));
  assert.match(await text(panel.locator('#checks')), /All checks passed/);
  assert.match(await text(panel.locator('#vinCheck')), /17 characters, check digit correct[\s\S]*2020, website agrees[\s\S]*Ford/);
  assert.match(await text(panel.locator('#assumed')), /Vehicle condition[\s\S]*Very good[\s\S]*Title status[\s\S]*Clean/);
  assert.equal(await panel.locator('#locationHint').count(), 0, "the ZIP came from the website's own structured data");
  assert.match(await text(panel.locator('#panel')), /Location[\s\S]*45501/);
  assert.match(await text(panel.locator('#cap')), /0 of 10 posts today/);
  await shot(page, 'drive-03-review.png');

  // the salesperson edits the description; the edit is what gets posted
  const edited = draft + '\nCall or message me any time.';
  await panel.locator('#description').fill(edited);
  await panel.locator('#checks').filter({ hasText: /All checks passed/ }).waitFor();

  // ---- 3. Open the Marketplace form: a new tab, filled in, photos attached ----
  await panel.locator('#openForm').click();
  const fb = await tabFrame(2);
  await panel.locator('#confirmPosted').waitFor({ timeout: 40000 });
  await panel.locator('#photos.done').waitFor({ timeout: 40000 });
  assert.match(await text(page.locator('#url')), /\/demo\/marketplace\/create\.html$/, 'the address bar shows the new tab');
  const form = await fb.evaluate(() => {
    const v = (id) => document.getElementById(id).value;
    const chosen = (id) => document.getElementById(id).dataset.value;
    return {
      vehicleType: chosen('vehicleType'), year: chosen('year'), make: v('make'), model: v('model'), vin: v('vin'), mileage: v('mileage'), price: v('price'),
      bodyStyle: v('bodyStyle'), exteriorColor: chosen('exteriorColor'), interiorColor: v('interiorColor'), fuelType: v('fuelType'), transmission: v('transmission'),
      location: v('location'), condition: v('condition'), titleStatus: v('titleStatus'), cleanTitle: document.getElementById('cleanTitle').checked,
      photos: document.getElementById('photoCount').textContent, thumbs: document.querySelectorAll('#thumbs img').length,
      popupsOpen: [...document.querySelectorAll('[role=listbox]')].filter((l) => !l.hidden).length,
    };
  });
  assert.deepEqual(form, {
    vehicleType: 'Car/Truck', year: '2020', make: 'Ford', model: 'F-150 XLT', vin: F150, mileage: '34512',
    price: '32,995', // the form reformats it
    bodyStyle: 'Truck', exteriorColor: 'Blue', interiorColor: 'Grey', fuelType: 'Gasoline', transmission: 'Automatic transmission',
    location: 'Springfield, Ohio', // not the Illinois one the form suggests first
    condition: 'Very good', titleStatus: 'Clean', cleanTitle: true,
    photos: '3 photos', thumbs: 3, popupsOpen: 0,
  });
  assert.equal(await fb.evaluate(() => document.getElementById('description').value), edited);
  const results = await text(panel.locator('#fillResults'));
  assert.match(results, /Filled in\s*17/);
  assert.doesNotMatch(results, /Needs a click/);
  assert.doesNotMatch(await text(panel.locator('#panel')), /Couldn't fill/);
  assert.match(await text(panel.locator('#photos')), /3 of 3 attached/);
  assert.equal(await publishClicks(), 0, 'the extension must not publish');
  await shot(page, 'drive-04-form-filled.png', { fullPage: true });

  // ---- 4. The person clicks Publish; the panel notices the listing page; the post is recorded ----
  await tab(2).locator('#publish').click();
  await panel.locator('#detected').waitFor({ timeout: 15000 });
  assert.match(await text(panel.locator('#detected')), /Looks like it posted/);
  const listingUrl = await panel.locator('#listingUrl').inputValue();
  assert.match(listingUrl, /\/demo\/marketplace\/item\.html\?id=\d+$/);
  assert.equal(await publishClicks(), 1, 'one click on Publish, by the person');
  await panel.locator('#confirmPosted').click();
  await panel.locator('#done').waitFor();
  assert.match(await text(panel.locator('#done')), /Recorded: 2020 Ford F-150 XLT at \$32,995/);
  await shot(page, 'drive-05-posted.png');

  // ---- 5. My listings and the Pilot tab ----
  await openPopup();
  assert.equal(await text(popupTab('mine').locator('.count')), '1');
  await popupTab('mine').click();
  const mine = await text(popup.locator('.panel'));
  assert.match(mine, /2020 Ford F-150 XLT[\s\S]*Listed \$32,995/);
  assert.equal(await popup.locator(`.panel a[href="${listingUrl}"]`).count(), 1, 'the listing link is kept');
  await shot(page, 'drive-06-my-listings.png');
  await popupTab('ready').click();
  assert.match(await text(popup.locator('.rows')), /2020 Ford F-150 XLT[\s\S]*Posted ✓/);
  await popupTab('pilot').click();
  const pilot1 = await text(popup.locator('.panel'));
  assert.match(pilot1, /Posted through Lot Sync\s*1\b/);
  assert.match(pilot1, /Every field filled every time/);
  await shot(page, 'drive-07-pilot.png', { fullPage: true });

  // ---- 6. A queue of two: the panel opens each form by itself; the person publishes the first and skips the second ----
  await popupTab('ready').click();
  await popup.locator(`.pick[data-vin="${CIVIC}"]`).check();
  await popup.locator(`.pick[data-vin="${RAV4}"]`).check();
  assert.equal(await text(popup.locator('#queueBtn')), 'Post 2 cars');
  await popup.locator('#queueBtn').click();
  await popup.locator('#status').filter({ hasText: /queue/i }).waitFor();
  const fb3 = await tabFrame(3); // car 1 (the Civic) opened its form without a click
  await panel.locator('#confirmPosted').waitFor({ timeout: 60000 });
  await panel.locator('#photos.done').waitFor({ timeout: 40000 });
  assert.match(await text(panel.locator('#queueBar')), /Car 1 of 2/);
  assert.equal(await fb3.evaluate(() => document.getElementById('vin').value), CIVIC);
  assert.equal(await fb3.evaluate(() => document.getElementById('make').value), 'Honda');
  await shot(page, 'drive-08-queue-car1.png');
  await tab(3).locator('#publish').click(); // the person
  const fb4 = await tabFrame(4); // car 2 (the RAV4) follows by itself
  await panel.locator('#queueBar').filter({ hasText: /Car 2 of 2/ }).waitFor({ timeout: 40000 });
  await panel.locator('#confirmPosted').waitFor({ timeout: 60000 });
  await panel.locator('#photos.done').waitFor({ timeout: 40000 });
  assert.match(await text(panel.locator('#queueBar')), /1 posted/);
  assert.equal(await fb4.evaluate(() => document.getElementById('vin').value), RAV4);
  assert.equal(await publishClicks(), 2);
  await panel.locator('#skipCar').click(); // the person decides not to post this one
  await panel.locator('#queueDone').waitFor({ timeout: 20000 });
  assert.match(await text(panel.locator('#queueBar')), /Queue finished: 2 cars · 1 posted, 1 skipped/);
  await shot(page, 'drive-09-queue-done.png');
  await openPopup();
  assert.equal(await text(popupTab('mine').locator('.count')), '2');
  await popupTab('ready').click();
  await popup.locator('button[data-action="clearQueue"]').click();

  // ---- 7. Day 2: the website sells the F-150 and drops the Civic's price; the rescan lists both ----
  await page.click('#day2');
  assert.match(await text(page.locator('#scenario')), /the 2020 Ford F-150 XLT sold, the 2019 Honda Civic EX dropped \$1,000/);
  await tab(1).locator('[id="5XYSAMPL2ME000011"]').waitFor(); // the arrival's card on the sample website
  assert.equal(await tab(1).locator(`[id="${F150}"]`).count(), 0, 'the sold car is off the website');
  await openPopup();
  await popup.locator('#scan').click();
  await popup.locator('h3').first().waitFor({ timeout: 20000 });
  const todo = await text(popup.locator('.panel'));
  assert.match(todo, /Take down\s*1[\s\S]*2020 Ford F-150 XLT[\s\S]*Gone from the website/);
  assert.match(todo, /Update price\s*1[\s\S]*2019 Honda Civic EX[\s\S]*\$19,995 → \$18,995/);
  assert.match(todo, /New arrivals\s*1[\s\S]*2021 Kia Sorento LX/);
  assert.match(todo, /Just became ready\s*1[\s\S]*2018 Chevrolet Equinox LT[\s\S]*photos added/);
  assert.equal(await text(popupTab('todo').locator('.count')), '2');
  await page.waitForFunction(() => document.getElementById('badge').textContent === '2', null, { timeout: 5000 });
  assert.equal(await badge(), '2', 'the toolbar icon carries the to-do count');
  await shot(page, 'drive-10-day2-todo.png', { fullPage: true });

  // ---- 8. Update the price: the person clicks Edit listing, Lot Sync fills the box, the person clicks Update ----
  await popup.locator('button[data-action="upkeep"][data-kind="price"]').click();
  const lst = await tabFrame(5);
  await panel.locator('#priceWaiting').waitFor({ timeout: 20000 });
  assert.match(await text(panel.locator('#priceWaiting')), /\$18,995/);
  await lst.waitForLoadState();
  assert.match(lst.url(), /item\.html\?id=\d+$/, 'the saved listing link is opened');
  await tab(5).locator('text=Edit listing').click(); // the person
  await panel.locator('#priceFilled').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => { const f = document.querySelector('iframe[data-tab-id="5"]'); const box = f && f.contentWindow.document.getElementById('price'); return box && box.value === '18995'; }, null, { timeout: 10000 });
  await shot(page, 'drive-11-price-filled.png');
  await tab(5).locator('#update').click(); // the person saves
  await panel.locator('#upkeepDone').waitFor({ timeout: 20000 });
  assert.match(await text(panel.locator('#upkeepDone')), /now shows \$18,995/);
  const listings = await page.evaluate(() => JSON.parse(sessionStorage.getItem('lotSyncSandbox.listings') || '{}'));
  const civicListing = Object.values(listings).find((l) => l.vin === CIVIC);
  assert.equal(civicListing.price, 18995, 'the sample listing holds the new price');
  await panel.locator('#upkeepClose').click();
  await openPopup();
  assert.equal(await text(popupTab('todo').locator('.count')), '1');
  await popupTab('mine').click();
  assert.match(await text(popup.locator('.panel')), /2019 Honda Civic EX[\s\S]*Listed \$18,995/);

  // ---- 9. Take the sold car down: the person clicks Mark as sold, Lot Sync notices ----
  await popupTab('todo').click();
  await popup.locator('button[data-action="upkeep"][data-kind="takeDown"]').click();
  const sold = await tabFrame(6);
  await panel.locator('#takeDownWaiting').waitFor({ timeout: 20000 });
  await sold.waitForLoadState();
  assert.match(sold.url(), /item\.html\?id=\d+$/);
  await page.waitForTimeout(3500); // "Sold" in a tab, a button and the prose must not count
  assert.equal(await panel.locator('#takeDownWaiting').count(), 1, 'still waiting for the person');
  await tab(6).locator('text=Mark as sold').click(); // the person
  await panel.locator('#upkeepDone').waitFor({ timeout: 20000 });
  assert.match(await text(panel.locator('#upkeepDone')), /sold or removed/);
  await shot(page, 'drive-12-sold.png');
  await panel.locator('#upkeepClose').click();
  await openPopup();
  assert.equal(await text(popupTab('todo').locator('.count')), '0');
  assert.equal(await text(popupTab('mine').locator('.count')), '1');
  await page.waitForFunction(() => document.getElementById('badge').hidden, null, { timeout: 5000 });
  await popupTab('pilot').click();
  const pilot2 = await text(popup.locator('.panel'));
  assert.match(pilot2, /Posted through Lot Sync\s*2\b/);
  assert.match(pilot2, /Sold cars to take down\s*1\b/);
  assert.match(pilot2, /Price changes\s*1\b/);
  await shot(page, 'drive-13-pilot-day2.png', { fullPage: true });

  // ---- 10. The background rescan (what the 3-hour alarm sends), from the top bar ----
  await page.click('#rescanNow');
  await page.locator('#rescanStatus').filter({ hasText: /Background rescan done/ }).waitFor({ timeout: 20000 });
  assert.match(await text(page.locator('#rescanStatus')), /8 used cars read, 0 to-do items/);
  assert.equal(await publishClicks(), 2, 'still only the person\'s two clicks');

  // ---- 11. Reset: everything back to the start ----
  await page.click('#reset');
  await page.waitForFunction(() => document.querySelectorAll('iframe.tab').length === 1, null, { timeout: 20000 });
  await waitReady();
  assert.equal(await text(popup.locator('#scan')), 'Scan website');
  assert.match(await text(popup.locator('.panel')), /click Scan website/);
  assert.equal(await publishClicks(), 0);
  assert.match(await text(page.locator('#scenario')), /day 1/);
  await shot(page, 'drive-14-reset.png');

  assert.deepEqual(errors, [], 'no console errors, page errors or failed requests');
  console.log('Test drive passed. Screenshots in demo/screenshots/');
} catch (e) {
  await shot(page, 'drive-failure.png', { fullPage: true }).catch(() => {});
  console.error('Panel:', (await panel.locator('#panel').textContent().catch(() => '')).replace(/\s+/g, ' ').slice(0, 600));
  console.error('Panel status:', await panel.locator('#status').textContent().catch(() => ''));
  console.error('Popup status:', await popup.locator('#status').textContent().catch(() => ''));
  console.error('Tabs:', await page.evaluate(() => [...document.querySelectorAll('iframe.tab')].map((f) => f.dataset.tabId + ':' + f.contentWindow.location.href)).catch(() => '?'));
  console.error('Errors:', errors);
  throw e;
} finally {
  await browser.close();
  server.close();
}
