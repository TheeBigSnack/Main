// End-to-end test of the batch queue: tick two ready cars in the popup and
// click "Post 2 cars". The side panel then walks them one at a time: re-check,
// describe, open and fill the MOCK form. The test clicks Publish on the first
// car as the salesperson would; the panel notices the listing address, records
// it and loads the next car by itself. The second car is a mild hybrid (the
// website says "Gasoline/Mild Electric Hybrid"), so its fuel is an assumption:
// the queue stops at review with it listed, and the test clicks Open the
// Marketplace form as the person would. For the second car the test presses
// "Saved as draft" (as if the person used Facebook's Save draft), and the
// queue finishes with 1 posted, 1 draft.
//
// The real facebook.com is never automated. Run: npm run test:e2e:queue

import { chromium } from 'playwright';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startMockSite } from './mock-dealer-site.mjs';
import { startMockMarketplace } from './mock-marketplace.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const shots = join(root, 'test/e2e/screenshots');
mkdirSync(shots, { recursive: true });

const extDir = mkdtempSync(join(tmpdir(), 'lot-sync-ext-')); // a fresh folder, so flows can run side by side
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
const profileDir = mkdtempSync(join(tmpdir(), 'lot-sync-profile-queue-'));
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
const publishCount = async (p) => (await p.request.get(`${marketOrigin}/publish-count`)).text();
const RAM = '1C6RR7FT0KS643289';
const WAGONEER = '1C4SJVDT7NS142834';

try {
  const ext = await context.newPage();
  await ext.goto('chrome://extensions');
  const extensionId = await ext.evaluate(async () => (await chrome.management.getAll()).find((e) => e.name === 'Lot Sync').id);
  await ext.close();
  const extUrl = (file) => `chrome-extension://${extensionId}/${file}`;

  const setup = await context.newPage();
  await setup.goto(extUrl('sidepanel.html'));
  await setup.evaluate(async ({ origin, marketOrigin }) => {
    await chrome.storage.local.set({
      [`settings:${origin}`]: {
        myStores: [], // every store, so two cars are ready
        basis: 'website',
        salesperson: { name: 'Roger', title: 'sales consultant' },
        dealer: { name: 'Ron Lewis Chrysler Dodge Jeep Ram Waynesburg', city: '', state: '', zip: '' }, // filled from the website's own address
        priceNote: 'Price includes the $490 doc fee; tax and tags extra.',
        dailyCap: 10,
        rewrite: { enabled: false, endpoint: '', key: '' },
      },
      devOverrides: {
        createUrl: `${marketOrigin}/marketplace/create/vehicle`,
        listingUrlPattern: `^${marketOrigin.replace(/\./g, '\\.')}/marketplace/item/(\\d+)`,
        afterPublishPatterns: [],
        settleMs: 200,
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
    await popup.setViewportSize({ width: 720, height: 640 });
    return popup;
  }
  const tab = (p, name) => p.locator(`.tabs button[data-view="${name}"]`);

  // ---- 1. Scan, tick both ready cars, Post 2 cars ----
  let popup = await openPopup();
  await popup.click('#scan');
  await popup.waitForSelector('.banner.info');
  await tab(popup, 'ready').click();
  assert.equal(await popup.locator('.pick').count(), 2);
  await popup.check('#pickAll');
  assert.equal(await popup.textContent('#queueBtn'), 'Post 2 cars');
  await popup.screenshot({ path: join(shots, 'queue-1-picked.png') });
  await popup.click('#queueBtn');
  await popup.waitForFunction(() => /queue/i.test(document.querySelector('#status').textContent));
  assert.match(await popup.textContent('#queueStatus'), /Car 1 of 2/);
  await popup.close();

  // ---- 2. The panel picks up the queue and, since every check passes, opens the form for car 1 by itself ----
  // Car 1's form opens already holding another car, like Facebook restoring a draft at load.
  await dealer.request.get(`${marketOrigin}/prefill?name=honda`);
  const panel = watch(await context.newPage());
  panelRef = panel;
  const fb1Promise = context.waitForEvent('page', { timeout: 40000 });
  await panel.goto(extUrl('sidepanel.html'));
  const fb1 = watch(await fb1Promise);
  await panel.waitForSelector('#confirmPosted', { timeout: 60000 });
  await panel.waitForSelector('#photos.done', { timeout: 30000 });
  assert.match(await panel.textContent('#queueBar'), /Car 1 of 2/);
  assert.equal(await fb1.inputValue('#vin'), RAM);
  assert.equal(await fb1.inputValue('#make'), 'Ram');
  assert.equal(await fb1.inputValue('#location'), 'Waynesburg, Pennsylvania', "ZIP from the website's structured data -> the right town");
  assert.equal(await fb1.evaluate(() => document.getElementById('cleanTitle').checked), true);
  const warning1 = await panel.textContent('#preexisting');
  assert.match(warning1, /already held another vehicle/);
  for (const piece of ['VIN "1HGCV1F30LA000000"', 'Year "2020"', 'Make "Honda"', 'Model "Accord EX-L"']) assert.ok(warning1.includes(piece), piece);
  assert.doesNotMatch(warning1, /Location/, "Facebook's own location default is not another car");
  assert.doesNotMatch(await panel.textContent('#panel'), /Couldn't fill/);
  await panel.screenshot({ path: join(shots, 'queue-2-car1-filled.png'), fullPage: true });

  // ---- 3. The person clicks Publish on car 1; the panel records it and loads car 2 ----
  // Car 2's draft lands late: 9 s after the page opens, over fields already filled
  // (the fill waits for a still form first, then takes several seconds).
  await dealer.request.get(`${marketOrigin}/prefill?name=honda&late=9000`);
  await fb1.click('#publish');
  await panel.waitForFunction(() => /Car 2 of 2/.test(document.querySelector('#queueBar')?.textContent || ''), null, { timeout: 40000 });
  // car 2's fuel is assumed (a mild hybrid listed as Hybrid), so the queue waits at review with it shown
  await panel.waitForSelector('#openForm', { timeout: 60000 });
  assert.match(await panel.textContent('#assumed'), /Fuel type[\s\S]*Hybrid[\s\S]*the website says "Gasoline\/Mild Electric Hybrid": a mild hybrid/);
  assert.equal(await panel.$('#confirmPosted'), null, 'the form was not opened by itself');
  await panel.screenshot({ path: join(shots, 'queue-3-car2-assumed.png'), fullPage: true });
  const fb2Promise = context.waitForEvent('page', { timeout: 40000 });
  await panel.click('#openForm');
  const fb2 = watch(await fb2Promise);
  await panel.waitForSelector('#confirmPosted', { timeout: 60000 });
  await panel.waitForSelector('#photos.done', { timeout: 30000 });
  assert.match(await panel.textContent('#queueBar'), /1 posted/);
  // every field shows the Wagoneer, not the Honda that landed mid-fill
  const car2 = await fb2.evaluate(() => ({
    prefilled: document.body.dataset.prefilled,
    year: document.getElementById('year').dataset.value,
    make: document.getElementById('make').value,
    model: document.getElementById('model').value,
    vin: document.getElementById('vin').value,
    mileage: document.getElementById('mileage').value,
    description: document.getElementById('description').value.slice(0, 40),
  }));
  assert.deepEqual(car2, { prefilled: '1', year: '2022', make: 'Jeep', model: 'Wagoneer Series III', vin: WAGONEER, mileage: '52402', description: '2022 Jeep Wagoneer Series III with 52,40' });
  // and the panel says Facebook changed fields after the fill, and that they were set again and held
  assert.equal(await panel.$('#preexisting'), null, 'the form was empty when filling started');
  const changed = await panel.textContent('#changedAfterFill');
  assert.match(changed, /Facebook changed[\s\S]*after Lot Sync filled it/);
  assert.match(changed, /"1HGCV1F30LA000000"|"2020"|"Honda"|"Accord EX-L"/);
  assert.match(changed, /set them again and they held/);
  assert.match(changed, /delete that draft on Facebook/);
  assert.doesNotMatch(await panel.textContent('#panel'), /Couldn't fill/);
  await panel.screenshot({ path: join(shots, 'queue-2b-restored-draft-warning.png'), fullPage: true });
  await dealer.request.get(`${marketOrigin}/prefill?name=none`);

  // pause and resume keep the place
  await panel.click('#queuePause');
  assert.match(await panel.textContent('#queueBar'), /paused/);
  await panel.click('#queueResume');
  assert.doesNotMatch(await panel.textContent('#queueBar'), /paused/);

  // ---- 4. Car 2 is saved as a draft on Facebook (the person's choice), not published ----
  await panel.click('#savedDraft');
  await panel.waitForSelector('#queueDone', { timeout: 20000 });
  assert.match(await panel.textContent('#queueBar'), /Queue finished: 2 cars · 1 posted, 1 saved as draft/);
  await panel.screenshot({ path: join(shots, 'queue-3-done.png'), fullPage: true });
  assert.equal(await publishCount(dealer), '1', 'only the person published, once');

  // ---- 5. The popup agrees: one listing, one draft ----
  popup = await openPopup();
  assert.equal(await tab(popup, 'mine').locator('.count').textContent(), '1');
  await tab(popup, 'mine').click();
  assert.match(await popup.textContent('.panel'), /2019 Ram 1500 Classic Express[\s\S]*Listed \$27,163/);
  await tab(popup, 'ready').click();
  const ready = await popup.textContent('.panel');
  assert.match(ready, /Queue finished: 2 cars/);
  assert.match(ready, /Jeep Wagoneer[\s\S]*Draft on Facebook/);
  await popup.click('button[data-action="clearQueue"]');
  assert.doesNotMatch(await popup.textContent('.panel'), /Queue finished/);
  await popup.screenshot({ path: join(shots, 'queue-4-popup.png') });

  // ---- 6. At the daily cap nothing more can be selected or posted ----
  await popup.evaluate(async (o) => {
    const k = `settings:${o}`;
    const s = (await chrome.storage.local.get(k))[k];
    s.dailyCap = 1; // one post was made today
    await chrome.storage.local.set({ [k]: s });
  }, origin);
  await popup.close();
  popup = await openPopup();
  await tab(popup, 'ready').click();
  assert.match(await popup.textContent('#capReached'), /Daily post cap reached \(1 of 1 today\)/);
  assert.equal(await popup.locator('.pick').count(), 0, 'no boxes to tick');
  assert.equal(await popup.locator('#queueBtn').count(), 0);
  assert.equal(await popup.locator('button[data-action="openPost"]:not([disabled])').count(), 0, 'Post buttons are disabled');
  await popup.screenshot({ path: join(shots, 'queue-5-cap-reached.png') });
  await popup.close();
  await panel.close();

  assert.deepEqual(errors, [], 'no console errors');
  console.log('Queue E2E passed. Screenshots in test/e2e/screenshots/');
} catch (e) {
  if (panelRef && !panelRef.isClosed()) {
    console.error('Panel status:', await panelRef.textContent('#status').catch(() => '(none)'));
    console.error('Panel text:', (await panelRef.textContent('#panel').catch(() => '')).replace(/\s+/g, ' ').slice(0, 700));
    await panelRef.screenshot({ path: join(shots, 'queue-failure.png'), fullPage: true }).catch(() => {});
    console.error('Pages:', context.pages().map((p) => p.url()).join(' | '));
    console.error('Saved flow:', await panelRef.evaluate(async (o) => {
      const all = await chrome.storage.local.get(null);
      const flow = all[`postFlow:${o}`] || {};
      const q = all[`postQueue:${o}`] || {};
      return JSON.stringify({ step: flow.step, vin: flow.vin, queueMode: flow.queueMode, fbTabId: flow.fbTabId, message: flow.message, queueIndex: q.index, queueStatus: q.status, postRequest: all.postRequest || null });
    }, origin).catch((e) => String(e)));
  }
  console.error('Console errors:', errors);
  throw e;
} finally {
  await context.close();
  // leave nothing behind: the throwaway profile and the extension copy
  for (const d of [profileDir, extDir]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { /* still locked by the closing browser; every run makes its own folders, so a leftover does no harm */ } }
  site.close();
  market.close();
}
