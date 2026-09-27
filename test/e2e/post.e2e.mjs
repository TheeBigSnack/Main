// End-to-end test of the one-click post flow: popup "Post" -> side panel
// re-checks the car and writes the description -> the salesperson edits it
// -> "Open the Marketplace form" fills a MOCK create-listing page and attaches
// photos -> the test clicks Publish as the salesperson would (the extension
// never does) -> the panel notices the listing address -> the post is
// recorded -> the popup shows it under My listings.
//
// The real facebook.com is never automated. Screenshots go to test/e2e/screenshots/.
// Run: npm run test:e2e:post   (needs Playwright + Chromium installed)

import { chromium } from 'playwright';
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startMockSite } from './mock-dealer-site.mjs';
import { startMockMarketplace } from './mock-marketplace.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const shots = join(root, 'test/e2e/screenshots');
mkdirSync(shots, { recursive: true });

// Test copy of the extension: it may script the two local mock servers and
// nothing else (the real facebook.com and image host permissions are removed).
const extDir = join(tmpdir(), 'lot-sync-ext-under-test-post');
rmSync(extDir, { recursive: true, force: true });
cpSync(join(root, 'extension'), extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
// No real side panel in tests: the test opens sidepanel.html as a tab and
// must be the only instance driving the flow.
manifest.permissions = manifest.permissions.filter((p) => p !== 'sidePanel');
delete manifest.side_panel;
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const site = await startMockSite();
const market = await startMockMarketplace();
const siteUrl = `http://127.0.0.1:${site.address().port}/used-vehicles/`;
const origin = new URL(siteUrl).origin;
const marketOrigin = `http://127.0.0.1:${market.address().port}`;
// See popup.e2e.mjs about LOTSYNC_E2E_CHANNEL.
const context = await chromium.launchPersistentContext(join(tmpdir(), 'lot-sync-profile-post-' + Date.now()), {
  channel: process.env.LOTSYNC_E2E_CHANNEL || 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  viewport: { width: 760, height: 900 },
});

const errors = [];
const watch = (p) => {
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  p.on('pageerror', (e) => errors.push(String(e)));
  return p;
};
const publishCount = async (p) => (await p.request.get(`${marketOrigin}/publish-count`)).text();

try {
  const ext = await context.newPage();
  await ext.goto('chrome://extensions');
  const extensionId = await ext.evaluate(async () => (await chrome.management.getAll()).find((e) => e.name === 'Lot Sync').id);
  await ext.close();
  const extUrl = (file) => `chrome-extension://${extensionId}/${file}`;

  // Settings and the test hooks go straight into storage (an extension page can call chrome.storage).
  const setup = await context.newPage();
  await setup.goto(extUrl('sidepanel.html'));
  await setup.evaluate(async ({ origin, marketOrigin }) => {
    await chrome.storage.local.set({
      [`settings:${origin}`]: {
        myStores: ['Ron Lewis Chrysler Dodge Jeep Ram Waynesburg'],
        basis: 'website',
        salesperson: { name: 'Roger', title: 'sales consultant' },
        // No ZIP on purpose: the location must still land in the right state.
        dealer: { name: 'Ron Lewis Chrysler Dodge Jeep Ram Waynesburg', city: 'Waynesburg', state: 'PA', zip: '' },
        priceNote: 'Price includes the $490 doc fee; tax and tags extra.',
        dailyCap: 10,
        rewrite: { enabled: false, endpoint: '', key: '' },
      },
      // Points the flow at the mock form instead of facebook.com (see formMap.js).
      devOverrides: {
        createUrl: `${marketOrigin}/marketplace/create/vehicle`,
        listingUrlPattern: `^${marketOrigin.replace(/\./g, '\\.')}/marketplace/item/(\\d+)`,
        afterPublishPatterns: [],
        settleMs: 200,
        recheckMs: 500,
      },
    });
  }, { origin, marketOrigin });
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
    await popup.setViewportSize({ width: 720, height: 590 });
    return popup;
  }
  const tab = (p, name) => p.locator(`.tabs button[data-view="${name}"]`);

  // ---- 1. Scan, then Post on the ready Ram ----
  let popup = await openPopup();
  await popup.click('#scan');
  await popup.waitForSelector('.banner.info');
  await tab(popup, 'ready').click();
  assert.match(await popup.textContent('.rows'), /2019 Ram 1500 Classic Express/);
  await popup.click('button[data-action="openPost"]');
  await popup.waitForFunction(() => /side panel/i.test(document.querySelector('#status').textContent));
  await popup.screenshot({ path: join(shots, 'post-1-ready-post.png') });
  await popup.close();

  // ---- 2. The side panel picks up the request (opened as a page here; Chrome docks it beside the tab in real use) ----
  const panel = watch(await context.newPage());
  await panel.goto(extUrl('sidepanel.html'));
  await panel.waitForSelector('#openForm', { timeout: 20000 });
  const car = await panel.textContent('#vehicle');
  assert.match(car, /2019 Ram 1500 Classic Express/);
  assert.match(car, /\$27,163/);
  const draft = await panel.inputValue('#description');
  assert.match(draft, /^2019 Ram 1500 Classic Express with 20,986 miles\./);
  assert.match(draft, /One owner according to the Carfax report\./);
  assert.match(draft, /pairs the HEMI 5\.7L V8/, "the car's own write-up is kept");
  assert.doesNotMatch(draft, /Documentation fee/, 'the lot-wide disclaimer is stripped');
  assert.match(draft, /Price includes the \$490 doc fee; tax and tags extra\./);
  assert.match(draft, /I'm Roger, sales consultant at Ron Lewis Chrysler Dodge Jeep Ram Waynesburg\./);
  assert.match(draft, /VIN 1C6RR7FT0KS643289\./);
  assert.match(await panel.textContent('#checks'), /All checks passed/);
  assert.match(await panel.textContent('#assumed'), /Vehicle condition[\s\S]*Very good[\s\S]*Title status[\s\S]*Clean[\s\S]*default/);
  assert.equal(await panel.$('#leftBlank'), null, 'nothing is left blank when defaults are set');
  assert.equal(await panel.$('#locationHint'), null, "the ZIP came from the website's own address, so no nudge");
  assert.match(await panel.textContent('#panel'), /Location[\s\S]*15370/);
  assert.match(await panel.textContent('#vinCheck'), /2019, website agrees[\s\S]*Stellantis/);
  assert.match(await panel.textContent('#cap'), /0 of 10 posts today/);
  await panel.screenshot({ path: join(shots, 'post-2-review.png'), fullPage: true });

  // ---- 3. The salesperson edits the description; the edit is what gets posted ----
  const edited = draft + '\nCall or message me any time.';
  await panel.fill('#description', edited);
  await panel.waitForFunction(() => /All checks passed/.test(document.querySelector('#checks')?.textContent || ''));

  // ---- 4a. First-run dry run: open the (mock) form and only check which fields can be found ----
  const [fb] = await Promise.all([context.waitForEvent('page'), panel.click('#checkForm')]);
  watch(fb);
  await panel.waitForSelector('#fillNow', { timeout: 30000 });
  const probe = await panel.textContent('#probeResults');
  assert.match(probe, /Found\s*16/);
  assert.match(probe, /Not found\s*1[\s\S]*Make/); // Make only appears after a year is chosen
  assert.match(probe, /1 file input\(s\) on the page · limit 20/);
  assert.equal(await fb.inputValue('#model'), '', 'the dry run fills nothing');
  assert.equal(await fb.evaluate(() => document.getElementById('makeWrap').hidden), true, 'Make is not on the page until a year is chosen');
  await panel.screenshot({ path: join(shots, 'post-3a-check-fields.png'), fullPage: true });

  // ---- 4b. Fill it in: the same tab gets filled and the photos attached ----
  await panel.click('#fillNow');
  await panel.waitForSelector('#confirmPosted', { timeout: 30000 });
  await panel.waitForSelector('#photos.done', { timeout: 30000 });
  await panel.screenshot({ path: join(shots, 'post-3-filled.png'), fullPage: true });
  await fb.screenshot({ path: join(shots, 'post-4-mock-form.png'), fullPage: true });

  const form = await fb.evaluate(() => {
    const v = (id) => document.getElementById(id).value;
    const chosen = (id) => document.getElementById(id).dataset.value;
    return {
      vehicleType: chosen('vehicleType'),
      year: chosen('year'), make: v('make'), model: v('model'), vin: v('vin'), mileage: v('mileage'), price: v('price'),
      bodyStyle: v('bodyStyle'), exteriorColor: chosen('exteriorColor'), interiorColor: v('interiorColor'),
      fuelType: v('fuelType'), transmission: v('transmission'), location: v('location'),
      condition: v('condition'), titleStatus: v('titleStatus'),
      cleanTitle: document.getElementById('cleanTitle').checked,
      photos: document.getElementById('photoCount').textContent,
      popupsOpen: [...document.querySelectorAll('[role=listbox]')].filter((l) => !l.hidden).length,
    };
  });
  assert.deepEqual(form, {
    vehicleType: 'Car/Truck', year: '2019', make: 'Ram', model: '1500 Classic Express', vin: '1C6RR7FT0KS643289', mileage: '20986',
    price: '27,163', // the page reformats it; the fill code accepts that
    bodyStyle: 'Truck', exteriorColor: 'Blue', interiorColor: 'Grey', fuelType: 'Gasoline', transmission: 'Automatic transmission',
    location: 'Waynesburg, Pennsylvania', // not the Ohio one the page suggests first
    condition: 'Very good', titleStatus: 'Clean', // the dealership's defaults
    cleanTitle: true, // the live form's checkbox, labelled only by nearby text
    photos: '3 photos',
    popupsOpen: 0, // the slow Year list was waited for, used, and closed
  });
  assert.equal(await fb.inputValue('#description'), edited);
  const results = await panel.textContent('#fillResults');
  assert.match(results, /Filled in\s*17/);
  assert.doesNotMatch(results, /Needs a click/);
  assert.doesNotMatch(await panel.textContent('#panel'), /Couldn't fill/);
  assert.match(await panel.textContent('#photos'), /3 of 3 attached/);
  assert.equal(await publishCount(dealer), '0', 'the extension must not publish');

  // ---- 5. The person clicks Publish (the test stands in for the salesperson) ----
  await fb.click('#publish');
  await panel.waitForSelector('#detected', { timeout: 15000 });
  assert.match(await panel.textContent('#detected'), /Looks like it posted/);
  assert.equal(await panel.inputValue('#listingUrl'), `${marketOrigin}/marketplace/item/424242/`);
  await panel.click('#confirmPosted');
  await panel.waitForSelector('#done');
  assert.match(await panel.textContent('#done'), /Recorded: 2019 Ram 1500 Classic Express at \$27,163/);
  await panel.screenshot({ path: join(shots, 'post-5-done.png') });
  assert.equal(await publishCount(dealer), '1');

  // ---- 6. The popup shows it under My listings, with the link ----
  popup = await openPopup();
  assert.equal(await tab(popup, 'mine').locator('.count').textContent(), '1');
  await tab(popup, 'mine').click();
  const mine = await popup.textContent('.panel');
  assert.match(mine, /2019 Ram 1500 Classic Express/);
  assert.match(mine, /Listed \$27,163/);
  assert.equal(await popup.getAttribute('.panel a[href*="/marketplace/item/424242/"]', 'href'), `${marketOrigin}/marketplace/item/424242/`);
  await tab(popup, 'ready').click();
  assert.match(await popup.textContent('.rows'), /Posted ✓/);
  await popup.screenshot({ path: join(shots, 'post-6-my-listings.png') });
  await popup.close();
  await panel.close();

  assert.deepEqual(errors, [], 'no console errors');
  console.log('Post E2E passed. Screenshots in test/e2e/screenshots/');
} finally {
  await context.close();
  site.close();
  market.close();
}
