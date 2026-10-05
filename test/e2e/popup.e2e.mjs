// End-to-end test: loads the real extension into Chromium, points it at the
// mock dealer site, and walks through scan -> mark posted -> car sells and a
// price drops -> rescan. Saves screenshots to test/e2e/screenshots/.
//
// Run: npm run test:e2e:popup   (needs Playwright + Chromium installed; npm run test:e2e runs every flow)

import { chromium } from 'playwright';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startMockSite } from './mock-dealer-site.mjs';
import { blockFacebook } from './noFacebook.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const shots = join(root, 'test/e2e/screenshots');
mkdirSync(shots, { recursive: true });

// Test copy of the extension that may script the local mock site without a
// click on the toolbar icon (the real one relies on that click via activeTab).
const extDir = mkdtempSync(join(tmpdir(), 'lot-current-ext-')); // a fresh folder, so flows can run side by side
cpSync(join(root, 'extension'), extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
manifest.permissions = manifest.permissions.filter((p) => p !== 'sidePanel'); // no real side panel in tests
delete manifest.side_panel;
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const server = await startMockSite();
const siteUrl = `http://127.0.0.1:${server.address().port}/used-vehicles/`;
// 'chromium' is Playwright's own build in new headless mode, which loads
// unpacked extensions. LOTSYNC_E2E_CHANNEL can point at another Chromium
// build, but note that branded Google Chrome and Edge 137+ ignore
// --load-extension, so they can't run this test.
const profileDir = mkdtempSync(join(tmpdir(), 'lot-current-profile-popup-'));
const context = await chromium.launchPersistentContext(profileDir, {
  channel: process.env.LOTSYNC_E2E_CHANNEL || 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  viewport: { width: 760, height: 640 },
});
const facebook = await blockFacebook(context); // the real facebook.com is never loaded (./noFacebook.mjs)

const errors = [];
let popup;
try {
  // Find the extension's id from the extensions page
  const ext = await context.newPage();
  await ext.goto('chrome://extensions');
  const extensionId = await ext.evaluate(async () => {
    const list = await chrome.management.getAll();
    return list.find((e) => e.name === 'Lot Current').id;
  });
  await ext.close();

  const dealer = await context.newPage();
  await dealer.goto(siteUrl);

  async function openPopup() {
    const popup = await context.newPage();
    popup.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    popup.on('pageerror', (e) => errors.push(String(e)));
    // In a real browser the popup sits on top of the dealer tab; here it has
    // its own tab, so point "the active tab" at the dealer page.
    await popup.addInitScript((url) => {
      const realQuery = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (q) => (q && q.active ? realQuery({ url }) : realQuery(q));
    }, siteUrl);
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.setViewportSize({ width: 720, height: 590 });
    return popup;
  }
  const tab = (p, name) => p.locator(`.tabs button[data-view="${name}"]`);

  // ---- Day 1: first scan ----
  popup = await openPopup();
  await popup.click('#scan');
  await popup.waitForSelector('.banner.info');
  // 6 used cars in the fixtures; new cars aren't even requested
  assert.match(await popup.textContent('.meta'), /6 used cars · 1 ready to post/);
  assert.equal(await tab(popup, 'ready').locator('.count').textContent(), '1'); // Ram at Waynesburg
  assert.equal(await tab(popup, 'notReady').locator('.count').textContent(), '1'); // Big Horn: no photos, no price
  assert.equal(await tab(popup, 'otherStores').locator('.count').textContent(), '3'); // Wagoneer, Hellcat, Tradesman
  assert.equal(await tab(popup, 'review').locator('.count').textContent(), '1'); // Pilot showing 0 miles
  await popup.screenshot({ path: join(shots, '1-first-scan.png') });

  await tab(popup, 'ready').click();
  assert.match(await popup.textContent('.rows'), /2019 Ram 1500 Classic Express/);
  // Mark posted asks when the listing went up (Cancel records nothing); this one went up today
  await popup.click('button[data-action="post"]');
  await popup.waitForSelector('.markWhen button[data-action="markBefore"]');
  assert.match(await popup.textContent('.markWhen'), /Listed on Facebook:\s*Today\s*Before today\s*Cancel/);
  await popup.click('button[data-action="markCancel"]');
  await popup.waitForSelector('button[data-action="post"]');
  assert.equal(await popup.$('button[data-action="unpost"]'), null, 'Cancel records nothing');
  await popup.click('button[data-action="post"]');
  await popup.click('button[data-action="markToday"]');
  await popup.waitForSelector('button[data-action="unpost"]');
  const marked = await popup.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const posted = Object.entries(all).find(([k]) => k.startsWith('posted:'))[1];
    const log = Object.entries(all).find(([k]) => k.startsWith('postLog:'));
    return { entry: Object.values(posted)[0], log: log ? log[1] : [] };
  });
  assert.equal(marked.entry.listedBefore, undefined, 'a post of today');
  assert.equal(marked.log.length, 1, 'on the day\'s post log');
  await popup.screenshot({ path: join(shots, '2-ready-marked-posted.png') });

  // ---- The price setting changes while the Ram is posted ----
  // A listing posted before the basis was kept on each entry (as an older
  // build left it) stays on the basis it was posted at: switching Settings to
  // the lower second price is not a website price change, and To do offers no
  // "price drop" for it; switching back offers no raise either (the posting
  // rules: a listing's price changes only when the website's does).
  const postedNow = () => popup.evaluate(async () => { const all = await chrome.storage.local.get(null); return all[Object.keys(all).find((k) => k.startsWith('posted:'))]; });
  await popup.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const key = Object.keys(all).find((k) => k.startsWith('posted:'));
    const posted = all[key];
    for (const e of Object.values(posted)) delete e.basis;
    await chrome.storage.local.set({ [key]: posted });
  });
  await popup.click('#settingsBtn');
  await popup.check('input[name="basis"][value="beforeFees"]');
  await popup.click('#panel button[type="submit"]');
  await popup.waitForFunction(() => (document.querySelector('#saved')?.textContent || '').length > 0);
  assert.match(await popup.textContent('#saved'), /Your listings keep the price they were posted at; the new price setting is for new posts\./);
  assert.deepEqual(Object.values(await postedNow()).map((e) => [e.price, e.basis]), [[27163, 'website']], 'the listing keeps the basis it was posted at');
  const scanned = () => popup.waitForFunction(() => document.querySelector('#settingsBtn').getAttribute('aria-pressed') === 'false' && document.querySelector('#panel .meta') && !document.querySelector('#scan').disabled);
  await popup.click('#scan');
  await scanned(); // the view turns to To do only once the scan is saved
  assert.match(await popup.textContent('#panel .meta'), /6 used cars/);
  assert.doesNotMatch(await popup.textContent('#panel'), /Update price/, 'a changed setting is not a website price change');
  assert.equal(await tab(popup, 'todo').locator('.count').textContent(), '0');
  await tab(popup, 'mine').click();
  assert.match(await popup.textContent('.panel'), /Matches the website[\s\S]*posted at the website's main price; your price setting now applies to new posts/);
  await popup.click('#settingsBtn'); // back to the main price for the rest of the run
  await popup.check('input[name="basis"][value="website"]');
  await popup.click('#panel button[type="submit"]');
  await popup.waitForFunction(() => /^Saved\./.test(document.querySelector('#saved')?.textContent || ''));
  await popup.click('#scan');
  await scanned();
  assert.doesNotMatch(await popup.textContent('#panel'), /Update price/, 'switching back is not a price change either');
  assert.equal(await tab(popup, 'todo').locator('.count').textContent(), '0', 'back on the main price: still nothing to edit');
  assert.deepEqual(Object.values(await postedNow()).map((e) => [e.price, e.basis]), [[27163, 'website']], 'the listing never moved');
  await tab(popup, 'ready').click();

  await tab(popup, 'otherStores').click();
  await popup.screenshot({ path: join(shots, '3-other-stores.png') });
  await tab(popup, 'notReady').click();
  assert.match(await popup.textContent('.panel'), /No photos on the website yet; No price on the website/);
  await popup.screenshot({ path: join(shots, '4-not-ready.png') });
  await popup.close();

  // ---- Day 2: the Ram sells, the Wagoneer drops $1,500, a Silverado arrives ----
  await dealer.request.get(`http://127.0.0.1:${server.address().port}/scenario?name=day2`);
  popup = await openPopup(); // reopening the popup keeps the saved scan
  assert.equal(await popup.textContent('#scan'), 'Rescan website');
  await popup.click('#scan');
  await popup.waitForSelector('h3');
  const todo = await popup.textContent('.panel');
  assert.match(todo, /Take down\s*1/);
  assert.match(todo, /2019 Ram 1500 Classic Express.*Gone from the website/);
  assert.match(todo, /Update price\s*1/);
  assert.match(todo, /\$38,383 → \$36,883/);
  assert.match(todo, /New arrivals\s*1/);
  assert.match(todo, /2021 Chevrolet Silverado 1500 LTZ[\s\S]*on the website since [^·]+· under a day on the lot/, "the arrival's date line: the mock site put it in stock today");
  assert.match(todo, /Just became ready\s*1/);
  assert.match(todo, /photos added, now at Waynesburg/);
  assert.equal(await tab(popup, 'todo').locator('.count').textContent(), '1');
  await popup.screenshot({ path: join(shots, '5-rescan-todo.png'), fullPage: true });

  // ---- Ready to post: the order, the New pill, the date line, the search box ----
  // Two ready cars now: the Silverado that arrived today and the Hellcat
  // (in stock 40 days ago on the mock site, with photos and at the store since today).
  await tab(popup, 'ready').click();
  const names = () => popup.locator('.rows .name').allTextContents();
  const SILVERADO = '2021 Chevrolet Silverado 1500 LTZ';
  const HELLCAT = '2016 Dodge Challenger SRT Hellcat';
  assert.equal(await popup.locator('#readySort').inputValue(), 'newest', 'newest on the lot is the default order');
  assert.deepEqual(await names(), [SILVERADO, HELLCAT], 'newest on the lot first');
  assert.deepEqual(await popup.locator('.rows .row').evaluateAll((rows) => rows.map((r) => Boolean(r.querySelector('.pill.new')))), [true, false], 'only the car within the window is marked New');
  assert.match(await popup.locator('.rows .row').nth(1).locator('.when').textContent(), /^on the website since .+ · 40 days on the lot$/);
  assert.match(await popup.textContent('#pickHint'), /Ticks the next 2 in this order/);
  await popup.selectOption('#readySort', 'name');
  await popup.waitForFunction(() => document.querySelector('.rows .name')?.textContent.startsWith('2016'));
  assert.deepEqual(await names(), [HELLCAT, SILVERADO], 'by name');
  await popup.selectOption('#readySort', 'longest');
  await popup.waitForFunction(() => document.querySelector('#readySort').value === 'longest' && document.querySelector('.rows .name')?.textContent.startsWith('2016'));
  assert.deepEqual(await names(), [HELLCAT, SILVERADO], 'longest on the lot first');
  await popup.selectOption('#readySort', 'newest');
  await popup.waitForFunction(() => document.querySelector('.rows .name')?.textContent.startsWith('2021'));
  // the search box: the stock number, the end of the VIN, words of the name; every word must match
  await popup.fill('#readySearch', 'w2001');
  assert.deepEqual(await names(), [SILVERADO], 'by stock number');
  await popup.fill('#readySearch', '244585');
  assert.deepEqual(await names(), [SILVERADO], 'by the last six of the VIN');
  await popup.fill('#readySearch', 'dodge hell');
  assert.deepEqual(await names(), [HELLCAT], 'by make and model words');
  await popup.fill('#readySearch', 'dodge silverado');
  assert.match(await popup.textContent('#readyBody'), /No cars match/);
  await popup.press('#readySearch', 'Escape');
  assert.equal(await popup.inputValue('#readySearch'), '', 'Escape clears the box');
  assert.deepEqual(await names(), [SILVERADO, HELLCAT]);
  // the order is remembered for this website: set it, close the popup, open it again
  await popup.selectOption('#readySort', 'price');
  await popup.waitForFunction(() => document.querySelector('.rows .name')?.textContent.startsWith('2021'));
  assert.deepEqual(await names(), [SILVERADO, HELLCAT], 'price, low to high: $36,603 before $53,485');
  // the list already showed this order, so the redraw proves nothing: wait for the save before closing
  await popup.waitForFunction(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all).some((k) => k.startsWith('settings:') && all[k]?.readySort === 'price');
  });
  await popup.close();
  popup = await openPopup();
  await tab(popup, 'ready').click();
  assert.equal(await popup.locator('#readySort').inputValue(), 'price', 'the order was kept with this website\'s settings');
  await popup.screenshot({ path: join(shots, '5b-ready-sorted.png') });
  await tab(popup, 'todo').click();

  await popup.click('button[data-action="takenDown"]');
  // the click writes to storage before it redraws: wait for the redraw rather than read the old count
  await popup.waitForFunction(() => document.querySelector('.tabs button[data-view="todo"] .count')?.textContent === '0');
  assert.equal(await tab(popup, 'todo').locator('.count').textContent(), '0');
  assert.equal(await tab(popup, 'mine').locator('.count').textContent(), '0');
  // the Ram's listing is down, but it was posted today: the daily cap still counts it
  await tab(popup, 'ready').click();
  assert.match(await popup.textContent('#pickHint'), /9 more posts allowed today\./);
  await tab(popup, 'todo').click();

  await popup.click('#settingsBtn');
  assert.match(await popup.textContent('.settings'), /usually \$490 higher than/);
  // the store's city, state and ZIP came from the website's structured data
  assert.equal(await popup.inputValue('input[name="dealerCity"]'), 'Waynesburg');
  assert.equal(await popup.inputValue('input[name="dealerState"]'), 'PA');
  assert.equal(await popup.inputValue('input[name="dealerZip"]'), '15370');
  await popup.screenshot({ path: join(shots, '6-settings.png') });
  await popup.close();

  // ---- Day 3: the Tradesman gets photos and moves to Waynesburg, so three cars are ready ----
  // The Silverado (in stock today, $36,603), the Hellcat (40 days, $53,485) and
  // the Tradesman (50 days, $33,485): each of the four orders gives a list no
  // other order gives, so a menu that mixed two of them up would show here.
  await dealer.request.get(`http://127.0.0.1:${server.address().port}/scenario?name=day3`);
  popup = await openPopup();
  // a new day for the cap too: the day's log of posts (the Ram's, from day 1) moves back a day
  await popup.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const key = Object.keys(all).find((k) => k.startsWith('postLog:'));
    const dayBefore = (at) => new Date(Date.parse(at) - 24 * 3600 * 1000).toISOString();
    await chrome.storage.local.set({ [key]: all[key].map((e) => ({ ...e, at: dayBefore(e.at) })) });
  });
  await popup.click('#scan');
  await popup.waitForFunction(() => /3 ready to post/.test(document.querySelector('.meta')?.textContent || '')); // the day-2 to-do list is on screen until the rescan ends
  assert.match(await popup.textContent('.panel'), /Just became ready\s*1[\s\S]*2025 Ram 1500 Tradesman[\s\S]*photos added, now at Waynesburg/);
  await tab(popup, 'ready').click();
  const TRADESMAN = '2025 Ram 1500 Tradesman';
  const VIN = { silverado: '3GCUYGED0MG244585', hellcat: '2C3CDZC96GH308445', tradesman: '1C6RRFGG7SN698641' };
  const checkedVins = () => popup.locator('.pick:checked').evaluateAll((boxes) => boxes.map((b) => b.dataset.vin));
  const sortTo = async (order, first) => {
    await popup.selectOption('#readySort', order);
    await popup.waitForFunction(([o, f]) => document.querySelector('#readySort').value === o && document.querySelector('.rows .name')?.textContent === f, [order, first]);
  };
  assert.equal(await popup.locator('#readySort').inputValue(), 'price', 'the order kept from day 2');
  assert.deepEqual(await names(), [TRADESMAN, SILVERADO, HELLCAT], 'price, low to high: $33,485, $36,603, $53,485');
  await sortTo('newest', SILVERADO);
  assert.deepEqual(await names(), [SILVERADO, HELLCAT, TRADESMAN], 'newest on the lot: today, 40 days, 50 days');
  await sortTo('longest', TRADESMAN);
  assert.deepEqual(await names(), [TRADESMAN, HELLCAT, SILVERADO], 'longest on the lot: 50 days, 40 days, today');
  await sortTo('name', HELLCAT);
  assert.deepEqual(await names(), [HELLCAT, SILVERADO, TRADESMAN], 'by name: 2016, 2021, 2025');
  await sortTo('newest', SILVERADO);

  // The caret stays in the search box when something else writes the scan
  // (the service worker's 3-hourly rescan, say) and the popup redraws itself.
  await popup.fill('#readySearch', 'che');
  assert.deepEqual(await names(), [SILVERADO]);
  await popup.evaluate(async () => {
    document.getElementById('readySearch').dataset.before = '1'; // gone once the popup redraws
    const all = await chrome.storage.local.get(null);
    const key = Object.keys(all).find((k) => k.startsWith('snapshot:'));
    await chrome.storage.local.set({ [key]: { ...all[key], takenAt: new Date().toISOString() } });
  });
  await popup.waitForFunction(() => document.getElementById('readySearch') && !document.getElementById('readySearch').dataset.before);
  assert.equal(await popup.evaluate(() => document.activeElement && document.activeElement.id), 'readySearch', 'the search box keeps the focus across a redraw the person did not cause');
  assert.equal(await popup.inputValue('#readySearch'), 'che', 'and what was typed');
  await popup.keyboard.type('v');
  assert.equal(await popup.inputValue('#readySearch'), 'chev', 'the next keystroke lands in the box');
  assert.deepEqual(await names(), [SILVERADO]);
  await popup.press('#readySearch', 'Escape');
  assert.deepEqual(await names(), [SILVERADO, HELLCAT, TRADESMAN]);

  // "Select the next N" ticks the first N in the CURRENT order: with 2 posts
  // left today and three cars, "longest" ticks the Tradesman and the Hellcat,
  // "newest" the Silverado and the Hellcat. The cap is 3: the Ram marked
  // posted today and taken down since is still one of today's posts.
  await popup.click('#settingsBtn');
  await popup.fill('input[name="dailyCap"]', '3');
  await popup.click('#panel button[type="submit"]');
  await popup.waitForFunction(() => (document.querySelector('#saved')?.textContent || '').length > 0);
  await tab(popup, 'ready').click();
  assert.match(await popup.textContent('#pickHint'), /Ticks the next 2 in this order\. 2 more posts allowed today\./);
  await sortTo('longest', TRADESMAN);
  await popup.check('#pickAll');
  assert.deepEqual(await checkedVins(), [VIN.tradesman, VIN.hellcat], 'Select the next 2 under "longest" ticks the first two in that order');
  assert.equal(await popup.textContent('#queueBtn'), 'Post 2 cars');
  assert.match(await popup.textContent('#status'), /Selected the next 2 in this order: that's all that's allowed today/);
  await popup.uncheck('#pickAll');
  assert.deepEqual(await checkedVins(), []);
  await sortTo('newest', SILVERADO);
  await popup.check('#pickAll');
  assert.deepEqual(await checkedVins(), [VIN.silverado, VIN.hellcat], 'and under "newest" the first two in that order');
  await popup.uncheck('#pickAll');
  assert.equal(await popup.textContent('#queueBtn'), 'Post selected');

  // A tick survives the search box hiding its row: tick the Silverado, find
  // the Hellcat by searching, tick it, clear the box: both are ticked, and
  // the queue takes both, in the order shown, the hidden one included.
  await popup.check(`.pick[data-vin="${VIN.silverado}"]`);
  assert.equal(await popup.textContent('#queueBtn'), 'Post 1 car');
  await popup.fill('#readySearch', 'dodge');
  assert.deepEqual(await names(), [HELLCAT]);
  assert.equal(await popup.textContent('#queueBtn'), 'Post 1 car', 'the hidden tick still counts');
  assert.match(await popup.textContent('#pickHint'), /1 ticked car hidden by the search/);
  await popup.check(`.pick[data-vin="${VIN.hellcat}"]`);
  assert.equal(await popup.textContent('#queueBtn'), 'Post 2 cars');
  await popup.press('#readySearch', 'Escape');
  assert.deepEqual(await checkedVins(), [VIN.silverado, VIN.hellcat], 'both ticks are there once the box is cleared');
  assert.equal(await popup.textContent('#queueBtn'), 'Post 2 cars');
  await popup.fill('#readySearch', 'dodge'); // the Silverado's row hidden again when the button is clicked
  await popup.click('#queueBtn');
  await popup.waitForFunction(() => /queue/i.test(document.querySelector('#status').textContent));
  const queue = await popup.evaluate(async () => { const all = await chrome.storage.local.get(null); return all[Object.keys(all).find((k) => k.startsWith('postQueue:'))]; });
  assert.deepEqual(queue.vins, [VIN.silverado, VIN.hellcat], 'the queue took the hidden tick too, in the order shown');
  assert.match(await popup.textContent('#queueStatus'), /Car 1 of 2/);
  await popup.screenshot({ path: join(shots, '7-day3-queue.png') });
  await popup.close();

  // ---- Not a dealer site ----
  const other = await context.newPage();
  await other.goto('about:blank');
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.click('#scan');
  assert.match(await popup.textContent('#status'), /Open your dealership's website/);

  assert.deepEqual(errors, [], 'no console errors');
  facebook.assertNone();
  console.log('E2E passed. Screenshots in test/e2e/screenshots/');
} catch (e) {
  // Say what the popup was showing, so a failure is diagnosable from the log.
  if (popup && !popup.isClosed()) {
    console.error('Popup status:', await popup.textContent('#status').catch(() => '(none)'));
    console.error('Popup panel:', (await popup.textContent('#panel').catch(() => '')).slice(0, 400));
    await popup.screenshot({ path: join(shots, 'failure.png') }).catch(() => {});
  }
  console.error('Console errors:', errors);
  throw e;
} finally {
  await context.close();
  // leave nothing behind: the throwaway profile and the extension copy
  for (const d of [profileDir, extDir]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { /* still locked by the closing browser; every run makes its own folders, so a leftover does no harm */ } }
  server.close();
}
