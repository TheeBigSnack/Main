// End-to-end test of the one-click post flow: popup "Post" -> side panel
// re-checks the car and writes the description -> the salesperson edits it
// -> "Open the Marketplace form" fills a MOCK create-listing page and attaches
// photos -> the test clicks Publish as the salesperson would (the extension
// never does) -> the panel notices the listing address -> the post is
// recorded -> the popup shows it under My listings. Last, the same form in
// Spanish: the dry run says the form map is English only, not just "not found".
//
// The real facebook.com is never automated. Screenshots go to test/e2e/screenshots/.
// Run: npm run test:e2e:post   (needs Playwright + Chromium installed)

import { chromium } from 'playwright';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startMockSite } from './mock-dealer-site.mjs';
import { startMockMarketplace, INITIAL_LISTINGS } from './mock-marketplace.mjs';
import { blockFacebook } from './noFacebook.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const shots = join(root, 'test/e2e/screenshots');
mkdirSync(shots, { recursive: true });

// Test copy of the extension: it may script the two local mock servers and
// nothing else (the real facebook.com and image host permissions are removed).
const extDir = mkdtempSync(join(tmpdir(), 'lot-current-ext-')); // a fresh folder, so flows can run side by side
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
const profileDir = mkdtempSync(join(tmpdir(), 'lot-current-profile-post-'));
const context = await chromium.launchPersistentContext(profileDir, {
  channel: process.env.LOTSYNC_E2E_CHANNEL || 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  viewport: { width: 760, height: 900 },
});
const facebook = await blockFacebook(context); // the real facebook.com is never loaded (./noFacebook.mjs)

const errors = [];
const watch = (p) => {
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  p.on('pageerror', (e) => errors.push(String(e)));
  return p;
};
// How many times Publish was clicked; and first, that nothing ever touched the
// mock form's decoy action controls (Next, Post, Save draft, Update, Delete,
// Mark as sold) or submitted it (the list is kept for the whole run).
const publishCount = async (p) => {
  assert.deepEqual(await (await p.request.get(`${marketOrigin}/actions`)).json(), [], 'nothing may touch an action control but the person');
  // nor did anything mark a listing sold, delete one or save an edit: Facebook lands on a listing page after Publish
  assert.deepEqual(await (await p.request.get(`${marketOrigin}/listing-actions`)).json(), [], 'nothing may mark sold, delete or update a listing but the person');
  assert.deepEqual(await (await p.request.get(`${marketOrigin}/listing-state`)).json(), INITIAL_LISTINGS, 'every listing is as it was');
  return (await p.request.get(`${marketOrigin}/publish-count`)).text();
};

try {
  const ext = await context.newPage();
  await ext.goto('chrome://extensions');
  const extensionId = await ext.evaluate(async () => (await chrome.management.getAll()).find((e) => e.name === 'Lot Current').id);
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
        salesperson: { name: 'Roger', title: 'sales consultant', closingLine: 'Ask for me by name when you come in.' },
        // No ZIP on purpose: the location must still land in the right state.
        dealer: { name: 'Ron Lewis Chrysler Dodge Jeep Ram Waynesburg', city: 'Waynesburg', state: 'PA', zip: '' },
        priceNote: 'Price includes the $490 doc fee; tax and tags extra.',
        dailyCap: 10,
        rulesReadAt: new Date().toISOString(), // set-up's posting rules, ticked (the side panel asks first otherwise: test/e2e/panel.e2e.mjs)
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
  let panel = watch(await context.newPage());
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
  assert.match(draft, /\nAsk for me by name when you come in\.$/, "the salesperson's closing line ends it");
  assert.doesNotMatch(draft, /Message me to set up a test drive/, 'in place of the stock invitation');
  assert.match(await panel.textContent('#checks'), /All checks passed/);
  assert.match(await panel.textContent('#assumed'), /Vehicle condition[\s\S]*Very good[\s\S]*Title status[\s\S]*Clean[\s\S]*default/);
  assert.equal(await panel.$('#leftBlank'), null, 'nothing is left blank when defaults are set');
  assert.equal(await panel.$('#locationHint'), null, "the ZIP came from the website's own address, so no nudge");
  assert.match(await panel.textContent('#panel'), /Location[\s\S]*15370/);
  assert.match(await panel.textContent('#vinCheck'), /2019, website agrees[\s\S]*Stellantis/);
  assert.match(await panel.textContent('#cap'), /0 of 10 posts today/);
  await panel.screenshot({ path: join(shots, 'post-2-review.png'), fullPage: true });

  // ---- 2b. The salesperson picks the photos and the highlights ----
  assert.match(await panel.textContent('#photoPickSummary'), /3 of 3 photos picked/);
  // with nothing ticked the form does not open
  await panel.click('#photosNone');
  await panel.waitForFunction(() => /No photos picked/.test(document.getElementById('photoPickSummary').textContent));
  const pagesBefore = context.pages().length;
  await panel.click('#openForm');
  await panel.waitForFunction(() => /No photos are ticked/.test(document.getElementById('status').textContent));
  assert.equal(context.pages().length, pagesBefore, 'no form tab opened');
  await panel.click('#photosDefault');
  await panel.waitForFunction(() => /3 of 3 photos picked/.test(document.getElementById('photoPickSummary').textContent));
  await panel.uncheck('#photo-2');
  await panel.waitForFunction(() => /2 of 3 photos picked/.test(document.getElementById('photoPickSummary').textContent));
  assert.equal(await panel.evaluate(() => document.activeElement.id), 'photo-2', 'focus stays on the box just unticked');
  await panel.click('#photoCover-1');
  await panel.waitForFunction(() => /Photo 2, cover/.test(document.getElementById('photoName-1').textContent));
  assert.match(await panel.textContent('#photoName-0'), /Photo 1, attached 2nd/);
  assert.match(await panel.textContent('#photoCount'), /2 picked/);
  const highlightBefore = draft.match(/Highlights: [^\n]*/)[0];
  assert.equal(highlightBefore, 'Highlights: Backup Camera, Tow Package, 4WD, Bluetooth, Keyless Entry, Power Windows.');
  await panel.uncheck('#feature-5'); // Power Windows
  await panel.check('#feature-6'); // Cruise Control
  await panel.waitForSelector('#highlightsChanged');
  await panel.click('#useHighlights');
  await panel.waitForFunction(() => /Highlights: Backup Camera, Tow Package, 4WD, Bluetooth, Keyless Entry, Cruise Control\./.test(document.getElementById('description').value));
  assert.match(await panel.textContent('#checks'), /All checks passed/);
  assert.equal(await panel.$('#highlightsChanged'), null);
  const picked = await panel.inputValue('#description');
  await panel.screenshot({ path: join(shots, 'post-2b-picked.png'), fullPage: true });

  // ---- 3. The salesperson edits the description; the edit is what gets posted ----
  const edited = picked + '\nCall or message me any time.';
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
    photos: '2 photos', // the two picked
    popupsOpen: 0, // the slow Year list was waited for, used, and closed
  });
  assert.equal(await fb.inputValue('#description'), edited);
  const results = await panel.textContent('#fillResults');
  assert.match(results, /Filled in\s*17/);
  assert.doesNotMatch(results, /Needs a click/);
  assert.doesNotMatch(await panel.textContent('#panel'), /Couldn't fill/);
  assert.match(await panel.textContent('#photos'), /2 of 2 attached/);
  // in the order picked: photo 2 as the cover, then photo 1
  const flowPhotos = await panel.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const key = Object.keys(all).find((k) => k.startsWith('postFlow:'));
    return all[key].listing.photos.map((u) => u.split('/').pop());
  });
  assert.deepEqual(flowPhotos, ['2.png', '1.png']);
  assert.equal(await publishCount(dealer), '0', 'the extension must not publish');

  // ---- 4b2. Fill again fills the fields only; Attach photos again sends every photo once more, and says so ----
  // (the mock form adds each change of its photo box to what it holds, as the panel expects of the real one)
  const fillsRecorded = () => panel.evaluate(async (o) => (((await chrome.storage.local.get(`pilot:${o}`))[`pilot:${o}`] || {}).fills || []).length, origin);
  assert.equal(await fillsRecorded(), 1);
  assert.match(await panel.textContent('#photosKept'), /Fill again fills the fields only/);
  await panel.click('#fillAgain');
  for (let i = 0; i < 300 && (await fillsRecorded()) < 2; i++) await panel.waitForTimeout(100);
  assert.equal(await fillsRecorded(), 2, 'Fill again filled the form again');
  await panel.waitForSelector('#photos.done');
  assert.equal(await fb.textContent('#photoCount'), '2 photos', 'Fill again sends no photo a second time');
  assert.match(await panel.textContent('#photos'), /2 of 2 attached/);
  assert.equal(await panel.$('#photosAgain'), null);
  assert.equal(await panel.textContent('#attachAgain'), 'Attach photos again');
  await panel.click('#attachAgain');
  await panel.waitForSelector('#photosAgain');
  await panel.waitForSelector('#photos.done', { timeout: 30000 });
  await fb.waitForFunction(() => document.getElementById('photoCount').textContent === '4 photos');
  assert.match(await panel.textContent('#photosAgain'), /each is on it twice now/);
  assert.equal(await publishCount(dealer), '0', 'the extension must not publish');

  // ---- 4c. A Post for another car while this form waits for Publish never drops it ----
  // (the popup's Post writes this request; another car's VIN, as written there)
  const otherCar = { origin, vin: 'TESTVIN00000000B2', dealerTabId: null, at: Date.now() };
  const refused = /Finish or stop the current post \(2019 Ram 1500 Classic Express\) first: its Marketplace form is open\. Then click Post again\./;
  await panel.evaluate((req) => chrome.storage.local.set({ postRequest: req }), otherCar);
  await panel.waitForFunction((re) => new RegExp(re).test(document.getElementById('status').textContent), refused.source);
  assert.ok(await panel.$('#confirmPosted'), 'still on the Ram, waiting for Publish');
  // and when the panel was closed meanwhile: it comes back on the Ram's form, not on the other car
  await panel.close();
  const writer = await context.newPage();
  await writer.goto(extUrl('popup.html'));
  await writer.evaluate((req) => chrome.storage.local.set({ postRequest: { ...req, at: Date.now() } }), otherCar);
  await writer.close();
  panel = watch(await context.newPage());
  await panel.goto(extUrl('sidepanel.html'));
  await panel.waitForSelector('#confirmPosted', { timeout: 20000 });
  await panel.waitForFunction((re) => new RegExp(re).test(document.getElementById('status').textContent), refused.source);
  assert.match(await panel.textContent('#vehicle'), /2019 Ram 1500 Classic Express/);
  assert.equal(await panel.evaluate(async () => (await chrome.storage.local.get('postRequest')).postRequest || null), null, 'the request is used up');

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

  // ---- 7. The Numbers tab (view id 'pilot'): one post with its timing, one fill with nothing to fix, and never the description ----
  await tab(popup, 'pilot').click();
  const pilotView = await popup.textContent('.panel');
  assert.match(pilotView, /Posted through Lot Current\s*1\b/);
  assert.match(pilotView, /Every field filled every time/);
  await popup.screenshot({ path: join(shots, 'post-7-pilot.png'), fullPage: true });
  const pilot = await popup.evaluate(async (o) => (await chrome.storage.local.get(`pilot:${o}`))[`pilot:${o}`], origin);
  assert.equal(pilot.posts.length, 1);
  assert.equal(pilot.posts[0].outcome, 'posted');
  assert.equal(pilot.posts[0].salesperson, 'Roger');
  assert.ok(pilot.posts[0].seconds >= 0 && pilot.posts[0].reviewedAt && pilot.posts[0].formOpenedAt && pilot.posts[0].filledAt, 'every step is timed');
  assert.equal(pilot.fills.length, 2, 'the dry run is not a fill; Fill it in now and Fill again are');
  for (const fill of pilot.fills) {
    assert.equal(fill.filled.length, 17);
    assert.deepEqual([...fill.partial, ...fill.blocked], []);
  }
  assert.doesNotMatch(JSON.stringify(pilot), /Call or message me|HEMI/, 'the description and the car\'s details are never recorded');
  await popup.close();
  await panel.close();

  // ---- 8. Facebook in another language: the dry run says so, instead of leaving a list of missing fields to puzzle over ----
  // The salesperson now covers every store, so a second car (the Wagoneer,
  // at Cranberry) is ready and not yet posted; the mock form opens in Spanish.
  popup = await openPopup();
  await popup.evaluate(async ({ o, url }) => {
    const k = `settings:${o}`;
    const data = await chrome.storage.local.get([k, 'devOverrides']);
    await chrome.storage.local.set({ [k]: { ...data[k], myStores: [] }, devOverrides: { ...data.devOverrides, createUrl: url } });
  }, { o: origin, url: `${marketOrigin}/marketplace/create/vehicle?lang=es` });
  await popup.close();
  popup = await openPopup();
  await popup.click('#scan'); // the store choice changes what is ready, so rescan
  await popup.waitForFunction(() => /2 ready to post/.test(document.querySelector('.meta')?.textContent || ''));
  await tab(popup, 'ready').click();
  const postButtons = popup.locator('button[data-action="openPost"]');
  assert.equal(await postButtons.count(), 1, 'the posted Ram offers no Post button, the Wagoneer does');
  await postButtons.first().click();
  await popup.waitForFunction(() => /side panel/i.test(document.querySelector('#status').textContent));
  await popup.close();
  const panelEs = watch(await context.newPage());
  await panelEs.goto(extUrl('sidepanel.html'));
  await panelEs.waitForSelector('#openForm', { timeout: 20000 });
  assert.match(await panelEs.textContent('#vehicle'), /2022 Jeep Wagoneer Series III/);
  const [fbEs] = await Promise.all([context.waitForEvent('page'), panelEs.click('#checkForm')]);
  watch(fbEs);
  await panelEs.waitForSelector('#probeResults', { timeout: 30000 });
  assert.equal(await fbEs.evaluate(() => document.documentElement.lang), 'es', 'the mock form is in Spanish');
  const panelText = await panelEs.textContent('#panel');
  assert.match(panelText, /form map is English only for now/);
  assert.match(panelText, /set to "es"/);
  const probeEs = await panelEs.textContent('#probeResults');
  const notFound = Number((/Not found\s*(\d+)/.exec(probeEs) || [])[1]);
  assert.ok(notFound >= 10, `nearly every field is missing on a Spanish form, but Not found says ${notFound}`);
  assert.match(probeEs, /Not found[\s\S]*Vehicle type[\s\S]*VIN[\s\S]*Price[\s\S]*Description/);
  assert.equal(await fbEs.inputValue('#vin'), '', 'the dry run fills nothing');
  await panelEs.screenshot({ path: join(shots, 'post-8-spanish-form.png'), fullPage: true });
  await fbEs.close();
  await panelEs.close();

  assert.equal(await publishCount(dealer), '1', 'still only the person\'s one click, and no listing marked sold, deleted or edited since');
  assert.deepEqual(errors, [], 'no console errors');
  facebook.assertNone();
  console.log('Post E2E passed. Screenshots in test/e2e/screenshots/');
} finally {
  await context.close();
  // leave nothing behind: the throwaway profile and the extension copy
  for (const d of [profileDir, extDir]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { /* still locked by the closing browser; every run makes its own folders, so a leftover does no harm */ } }
  site.close();
  market.close();
}
