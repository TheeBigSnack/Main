// Drives the Lot Current test drive (demo/) the way a person would, in headless
// Chromium, and checks every step: scan, Post, the side panel's re-check and
// description, the sample Marketplace form filling itself, the person's own
// click on Publish (this script stands in for the person; the extension never
// clicks it, and the sample Marketplace counts the clicks on Publish, Update,
// Mark as sold and Delete, each checked before and after the person's own),
// confirm, My listings, the Numbers tab, a queue of two, day 2 on the website,
// the rescan's To do items, the price update and the take-down through the
// side panel, the background rescan, and Reset. Then a second pass over the
// other sample website, which publishes standard vehicle data on each car's
// page: switching to it, the scan, a post, the side panel's own list (Chrome's
// question for the website, said no to and then yes), day 2 and the
// background rescan.
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
// Example Auto Outlet, the second sample website (demo/site-standard/inventory.js)
const STD_CIVIC = '2HGSAMPL1KH000201';
const STD_ACCORD = '1HGSAMPL3LA000202';

// The sample lot's in-stock dates are N days before the day the sandbox runs,
// by the person's own calendar (demo/site/inventory.js inStockDate), and the
// popup counts a website's calendar date in that same day (src/readyList.js
// ageDays), so the words are exact at any hour in any time zone.
const onLot = (n) => (n === 0 ? 'under a day on the lot' : `${n} day${n === 1 ? '' : 's'} on the lot`);

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
// every button only a person clicks on the sample Marketplace, as counted there (demo/marketplace/marketplace.js)
const clicks = () => page.evaluate(() => Object.fromEntries(['publish', 'update', 'markSold', 'delete'].map((k) => [k, Number(sessionStorage.getItem(`lotSyncSandbox.${k}Clicks`) || 0)])));
const storedListing = (vin) => page.evaluate((v) => Object.values(JSON.parse(sessionStorage.getItem('lotSyncSandbox.listings') || '{}')).find((l) => l.vin === v), vin);
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
  // newest on the lot first (the sample lot's in-stock dates: F-150 2 days, Grand Cherokee 5, RAV4 12, Civic 25), the two within the 7-day window marked New
  const readyRows = popup.locator('.rows .row');
  assert.deepEqual(await readyRows.locator('.name').allTextContents(), ['2020 Ford F-150 XLT', '2022 Jeep Grand Cherokee Laredo', '2021 Toyota RAV4 XLE', '2019 Honda Civic EX']);
  assert.deepEqual(await readyRows.locator('.when').allTextContents().then((l) => l.map((t) => t.replace(/since .* ·/, 'since … ·'))), [2, 5, 12, 25].map((n) => `on the website since … · ${onLot(n)}`));
  assert.deepEqual(await readyRows.evaluateAll((rows) => rows.map((r) => Boolean(r.querySelector('.pill.new')))), [true, true, false, false]);
  assert.equal(await popup.locator('#readySort').inputValue(), 'newest');
  await popup.locator('#readySearch').fill('civ');
  assert.deepEqual(await readyRows.locator('.name').allTextContents(), ['2019 Honda Civic EX'], 'the search box filters as you type');
  await popup.locator('#readySearch').press('Escape');
  assert.equal(await readyRows.count(), 4, 'Escape clears the search');
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

  // ---- 5. My listings and the Numbers tab (view id 'pilot') ----
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
  assert.match(pilot1, /Posted through Lot Current\s*1\b/);
  assert.match(pilot1, /Every field filled every time/);
  await shot(page, 'drive-07-pilot.png', { fullPage: true });

  // ---- 6. A queue of two: the panel opens each form by itself; the person publishes the first and skips the second ----
  // The queue takes the ticked cars in the order shown: longest on the lot puts the Civic (25 days) before the RAV4 (12).
  await popupTab('ready').click();
  await popup.locator('#readySort').selectOption('longest');
  await popup.locator('.rows .row').first().filter({ hasText: 'Civic' }).waitFor();
  assert.deepEqual(await popup.locator('.rows .name').allTextContents(), ['2019 Honda Civic EX', '2021 Toyota RAV4 XLE', '2022 Jeep Grand Cherokee Laredo', '2020 Ford F-150 XLT'], 'longest on the lot first');
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
  // new arrivals stay listed for the window: the Sorento that arrived today and the Grand Cherokee, 5 days on the lot and still not posted; the posted F-150 and the older cars are not
  assert.match(todo, new RegExp(`New arrivals\\s*2[\\s\\S]*2021 Kia Sorento LX[\\s\\S]*on the website since [^·]+· ${onLot(1)}[\\s\\S]*2022 Jeep Grand Cherokee Laredo[\\s\\S]*${onLot(5)}`));
  assert.doesNotMatch(todo.slice(todo.indexOf('New arrivals'), todo.indexOf('Just became ready')), /F-150|RAV4|Civic/);
  assert.match(todo, /Queue all 2 ready arrivals/);
  assert.match(todo, /Just became ready\s*1[\s\S]*2018 Chevrolet Equinox LT[\s\S]*photos added/);
  assert.equal(await text(popupTab('todo').locator('.count')), '2');
  await page.waitForFunction(() => document.getElementById('badge').textContent === '2', null, { timeout: 5000 });
  assert.equal(await badge(), '2', 'the toolbar icon carries the to-do count');
  await shot(page, 'drive-10-day2-todo.png', { fullPage: true });

  // ---- 8. Update the price: the person clicks Edit listing, Lot Current fills the box, the person clicks Update ----
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
  // the box is filled and nothing is saved: Update waits for the person
  assert.deepEqual(await clicks(), { publish: 2, update: 0, markSold: 0, delete: 0 }, 'the extension clicked nothing on the listing');
  assert.equal((await storedListing(CIVIC)).price, 19995, 'the listing keeps its old price until the person clicks Update');
  await tab(5).locator('#update').click(); // the person saves
  await panel.locator('#upkeepDone').waitFor({ timeout: 20000 });
  assert.match(await text(panel.locator('#upkeepDone')), /now shows \$18,995/);
  assert.equal((await storedListing(CIVIC)).price, 18995, 'the sample listing holds the new price');
  assert.deepEqual(await clicks(), { publish: 2, update: 1, markSold: 0, delete: 0 }, "one click on Update, the person's");
  await panel.locator('#upkeepClose').click();
  await openPopup();
  assert.equal(await text(popupTab('todo').locator('.count')), '1');
  await popupTab('mine').click();
  assert.match(await text(popup.locator('.panel')), /2019 Honda Civic EX[\s\S]*Listed \$18,995/);

  // ---- 9. Take the sold car down: the person clicks Mark as sold, Lot Current notices ----
  await popupTab('todo').click();
  await popup.locator('button[data-action="upkeep"][data-kind="takeDown"]').click();
  const sold = await tabFrame(6);
  await panel.locator('#takeDownWaiting').waitFor({ timeout: 20000 });
  await sold.waitForLoadState();
  assert.match(sold.url(), /item\.html\?id=\d+$/);
  await page.waitForTimeout(3500); // "Sold" in a tab, a button and the prose must not count
  assert.equal(await panel.locator('#takeDownWaiting').count(), 1, 'still waiting for the person');
  assert.deepEqual(await clicks(), { publish: 2, update: 1, markSold: 0, delete: 0 }, 'the extension clicked neither Mark as sold nor Delete');
  assert.equal((await storedListing(F150)).sold, false);
  await tab(6).locator('text=Mark as sold').click(); // the person
  await panel.locator('#upkeepDone').waitFor({ timeout: 20000 });
  assert.match(await text(panel.locator('#upkeepDone')), /sold or removed/);
  assert.deepEqual(await clicks(), { publish: 2, update: 1, markSold: 1, delete: 0 }, "one click on Mark as sold, the person's");
  await shot(page, 'drive-12-sold.png');
  await panel.locator('#upkeepClose').click();
  await openPopup();
  assert.equal(await text(popupTab('todo').locator('.count')), '0');
  assert.equal(await text(popupTab('mine').locator('.count')), '1');
  await page.waitForFunction(() => document.getElementById('badge').hidden, null, { timeout: 5000 });
  await popupTab('pilot').click();
  const pilot2 = await text(popup.locator('.panel'));
  assert.match(pilot2, /Posted through Lot Current\s*2\b/);
  assert.match(pilot2, /Sold cars to take down\s*1\b/);
  assert.match(pilot2, /Price changes\s*1\b/);
  await shot(page, 'drive-13-pilot-day2.png', { fullPage: true });

  // ---- 10. The background rescan (what the 3-hour alarm sends), from the top bar ----
  await page.click('#rescanNow');
  await page.locator('#rescanStatus').filter({ hasText: /Background rescan done/ }).waitFor({ timeout: 20000 });
  assert.match(await text(page.locator('#rescanStatus')), /8 used cars read, 0 to-do items/);
  assert.equal(await publishClicks(), 2, 'still only the person\'s two clicks');
  assert.deepEqual(await clicks(), { publish: 2, update: 1, markSold: 1, delete: 0 }, "still only the person's clicks");
  assert.deepEqual([(await storedListing(F150)).deleted, (await storedListing(CIVIC)).sold, (await storedListing(CIVIC)).deleted], [false, false, false], 'nothing else changed on the sample listings');

  // ---- 11. Reset: everything back to the start ----
  await page.click('#reset');
  await page.waitForFunction(() => document.querySelectorAll('iframe.tab').length === 1, null, { timeout: 20000 });
  await waitReady();
  assert.equal(await text(popup.locator('#scan')), 'Scan website');
  assert.match(await text(popup.locator('.panel')), /click Scan website/);
  assert.equal(await publishClicks(), 0);
  assert.deepEqual(await clicks(), { publish: 0, update: 0, markSold: 0, delete: 0 }, 'Reset clears every count');
  assert.match(await text(page.locator('#scenario')), /day 1/);
  await shot(page, 'drive-14-reset.png');

  // ---- 12. The other sample website: standard vehicle data on each car's own page ----
  await page.selectOption('#siteChoice', 'standard');
  await page.locator('#siteNote').filter({ hasText: /the sandbox was reset/ }).waitFor({ timeout: 30000 });
  await waitReady();
  assert.match(await text(page.locator('#siteNote')), /Both sample websites share this page's address/);
  assert.match(await text(page.locator('#url')), /\/demo\/site-standard\/index\.html#\/used-vehicles\/$/);
  assert.equal(await publishClicks(), 0);
  await tab(1).locator('text=Example Auto Outlet is not a real dealership').waitFor();
  await openPopup();
  await popup.locator('#scan').click();
  await popup.locator('.banner.info').waitFor({ timeout: 30000 });
  // six ready; the Malibu (its markup price is not the one the page shows) and the Wrangler (no photos) not ready;
  // the Outback (12 miles) needs a look, and the trade-in trailer is either left out or held there too
  const stdMeta = await text(popup.locator('.meta'));
  const trailerKept = /^Last scan .* · 10 used cars/.test(stdMeta);
  assert.match(stdMeta, /(9|10) used cars · 6 ready to post/);
  assert.equal(await text(popupTab('ready').locator('.count')), '6');
  assert.equal(await text(popupTab('notReady').locator('.count')), '2');
  assert.equal(await text(popupTab('review').locator('.count')), trailerKept ? '2' : '1');
  await popupTab('ready').click();
  const stdReady = await text(popup.locator('.rows'));
  for (const name of ['2018 Ford Escape SE', '2019 Ford F-150 XLT', '2019 Honda Civic EX', '2020 Honda Accord Sport', '2021 Kia Sorento LX', '2022 Toyota RAV4 XLE']) assert.ok(stdReady.includes(name), `${name} is ready to post`);
  assert.doesNotMatch(stdReady, /Malibu|Trailer|Telluride|Outback/);
  await popupTab('notReady').click();
  const stdNotReady = await text(popup.locator('.panel'));
  assert.match(stdNotReady, /2017 Chevrolet Malibu LT[\s\S]*No price on the website/);
  assert.doesNotMatch(stdNotReady, /14,995/, 'the markup price the page does not show is never used');
  await shot(page, 'drive-15-standard-scanned.png');

  // ---- 13. Post the Civic from its own page; the person publishes ----
  await popupTab('ready').click();
  await popup.locator(`button[data-action="openPost"][data-vin="${STD_CIVIC}"]`).click();
  await popup.locator('#status').filter({ hasText: /side panel/i }).waitFor();
  await panel.locator('#openForm').waitFor({ timeout: 20000 });
  assert.match(await text(panel.locator('#vehicle')), /2019 Honda Civic EX[\s\S]*\$19,995/);
  const stdDraft = await panel.locator('#description').inputValue();
  assert.match(stdDraft, /^2019 Honda Civic EX with 41,230 miles\./);
  assert.match(stdDraft, /I'm Alex, sales consultant at Example Auto Outlet\./);
  assert.match(stdDraft, /Tax, title and registration are extra\./);
  assert.match(stdDraft, /This Civic EX has the 1\.5L Turbo 4-Cylinder, a CVT and a sunroof\./, "the car's own write-up is kept");
  assert.match(await text(panel.locator('#checks')), /All checks passed/);
  assert.match(await text(panel.locator('#panel')), /Location[\s\S]*45505/);
  await panel.locator('#openForm').click();
  const stdForm = await tabFrame(2);
  await panel.locator('#confirmPosted').waitFor({ timeout: 40000 });
  await panel.locator('#photos.done').waitFor({ timeout: 40000 });
  const stdFields = await stdForm.evaluate(() => {
    const v = (id) => document.getElementById(id).value;
    return { year: document.getElementById('year').dataset.value, make: v('make'), model: v('model'), vin: v('vin'), mileage: v('mileage'), price: v('price'), location: v('location'), photos: document.getElementById('photoCount').textContent };
  });
  assert.deepEqual(stdFields, { year: '2019', make: 'Honda', model: 'Civic EX', vin: STD_CIVIC, mileage: '41230', price: '19,995', location: 'Springfield, Ohio', photos: '3 photos' });
  assert.match(await text(panel.locator('#fillResults')), /Filled in\s*17/);
  assert.equal(await publishClicks(), 0, 'the extension must not publish');
  await tab(2).locator('#publish').click(); // the person
  await panel.locator('#detected').waitFor({ timeout: 15000 });
  await panel.locator('#confirmPosted').click();
  await panel.locator('#done').waitFor();
  assert.match(await text(panel.locator('#done')), /Recorded: 2019 Honda Civic EX at \$19,995/);
  assert.equal(await publishClicks(), 1);
  await shot(page, 'drive-16-standard-posted.png');

  // ---- 13b. The side panel's own list, and Chrome's question for the website from a click there ----
  // The sandbox serves the sample website from its own address, which counts
  // as allowed; that is taken back here, so the panel has to ask, as it would
  // for a website the person never allowed automatic rescans for.
  await panel.locator('#postAnother').click();
  await panel.locator('#panelReady').waitFor();
  assert.match(await text(panel.locator('#panelMeta')), /Last scan .* · 5 ready to post · 9 more posts allowed today/);
  assert.equal(await panel.locator(`button[data-post-vin="${STD_CIVIC}"]`).count(), 0, 'the posted Civic is off the list');
  const sitePattern = await page.evaluate(() => {
    const hub = window.__lotSyncHub;
    const pattern = location.origin + '/' + '*';
    hub.permissionsRemove({ origins: [pattern] });
    hub.permissionAnswer = false; // the person says no to Chrome's prompt
    hub.permissionRequests.length = 0;
    return pattern;
  });
  await panel.locator('button[data-post-vin="1FMSAMPL5JU000205"]').click(); // Post on the Escape
  await panel.locator('#status').filter({ hasText: /Not allowed, so Lot Current can't read .* from the side panel/ }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__lotSyncHub.permissionRequests), [[sitePattern]], 'asked for the website only, from the click');
  assert.equal(await panel.locator('#panelReady').count(), 1, 'nothing was started');
  await page.evaluate(() => { window.__lotSyncHub.permissionAnswer = true; }); // this time the person allows it
  await panel.locator('#panelRescan').click();
  await panel.locator('#status').filter({ hasText: /^Rescanned \S+: \d+ used cars?\./ }).waitFor({ timeout: 30000 });
  assert.deepEqual(await page.evaluate(() => window.__lotSyncHub.permissionRequests), [[sitePattern], [sitePattern]]);
  assert.match(await text(panel.locator('#panelMeta')), /5 ready to post/);
  await shot(page, 'drive-16b-panel-list.png');

  // ---- 14. The Accord was listed by hand: Mark posted ----
  await openPopup();
  await popupTab('ready').click();
  await popup.locator(`button[data-action="post"][data-vin="${STD_ACCORD}"]`).click();
  await popup.locator(`button[data-action="unpost"][data-vin="${STD_ACCORD}"]`).waitFor();

  // ---- 15. Day 2: the older listing sells (its page is gone), the newer one drops its price ----
  await page.click('#day2');
  assert.match(await text(page.locator('#scenario')), /the 2019 Honda Civic EX sold, the 2020 Honda Accord Sport dropped \$1,000, the 2016 Jeep Wrangler Sport got photos, and a 2021 Hyundai Tucson SEL arrived/);
  await openPopup();
  await popup.locator('#scan').click();
  await popup.locator('h3').first().waitFor({ timeout: 30000 });
  const stdTodo = await text(popup.locator('.panel'));
  assert.match(stdTodo, /Take down\s*1[\s\S]*2019 Honda Civic EX[\s\S]*Gone from the website/);
  assert.match(stdTodo, /Update price\s*1[\s\S]*2020 Honda Accord Sport[\s\S]*\$23,495 → \$22,495/);
  // this website gives no in-stock dates, so the arrival carries the scan that first saw it, and never a count of days on the lot
  assert.match(stdTodo, /New arrivals\s*1[\s\S]*2021 Hyundai Tucson SEL[\s\S]*Lot Current first saw it /);
  assert.doesNotMatch(stdTodo, /on the lot/);
  assert.match(stdTodo, /Just became ready\s*1[\s\S]*2016 Jeep Wrangler Sport/);
  assert.equal(await text(popupTab('todo').locator('.count')), '2');
  await page.waitForFunction(() => document.getElementById('badge').textContent === '2', null, { timeout: 5000 });
  await shot(page, 'drive-17-standard-day2-todo.png', { fullPage: true });

  // ---- 16. The background rescan reads the pages from the service worker ----
  await page.click('#rescanNow');
  await page.locator('#rescanStatus').filter({ hasText: /Background rescan done/ }).waitFor({ timeout: 30000 });
  assert.match(await text(page.locator('#rescanStatus')), new RegExp(`${trailerKept ? 10 : 9} used cars read, 2 to-do items`));
  assert.equal(await publishClicks(), 1, "still only the person's one click");
  assert.deepEqual(await clicks(), { publish: 1, update: 0, markSold: 0, delete: 0 }, "still only the person's one click");

  // ---- 17. Reset keeps the chosen website; switching back starts over on the first one ----
  await page.click('#reset');
  await waitReady();
  assert.match(await text(page.locator('#url')), /\/demo\/site-standard\/index\.html#\/used-vehicles\/$/);
  await page.selectOption('#siteChoice', 'service');
  await page.locator('#siteNote').filter({ hasText: /Now showing Example Motors/ }).waitFor({ timeout: 30000 });
  await waitReady();
  assert.match(await text(page.locator('#url')), /\/demo\/site\/index\.html$/);
  assert.equal(await text(popup.locator('#scan')), 'Scan website');

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
