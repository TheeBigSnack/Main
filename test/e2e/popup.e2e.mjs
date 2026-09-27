// End-to-end test: loads the real extension into Chromium, points it at the
// mock dealer site, and walks through scan -> mark posted -> car sells and a
// price drops -> rescan. Saves screenshots to test/e2e/screenshots/.
//
// Run: npm run test:e2e   (needs Playwright + Chromium installed)

import { chromium } from 'playwright';
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startMockSite } from './mock-dealer-site.mjs';

const root = resolve(new URL('../..', import.meta.url).pathname);
const shots = join(root, 'test/e2e/screenshots');
mkdirSync(shots, { recursive: true });

// Test copy of the extension that may script the local mock site without a
// click on the toolbar icon (the real one relies on that click via activeTab).
const extDir = join(tmpdir(), 'lot-sync-ext-under-test');
rmSync(extDir, { recursive: true, force: true });
cpSync(join(root, 'extension'), extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const server = await startMockSite();
const siteUrl = `http://127.0.0.1:${server.address().port}/used-vehicles/`;
const context = await chromium.launchPersistentContext(join(tmpdir(), 'lot-sync-profile-' + Date.now()), {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  viewport: { width: 760, height: 640 },
});

const errors = [];
try {
  // Find the extension's id from the extensions page
  const ext = await context.newPage();
  await ext.goto('chrome://extensions');
  const extensionId = await ext.evaluate(async () => {
    const list = await chrome.management.getAll();
    return list.find((e) => e.name === 'Lot Sync').id;
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
  let popup = await openPopup();
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
  await popup.click('button[data-action="post"]');
  await popup.waitForSelector('button[data-action="unpost"]');
  await popup.screenshot({ path: join(shots, '2-ready-marked-posted.png') });

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
  assert.match(todo, /2021 Chevrolet Silverado 1500 LTZ/);
  assert.match(todo, /Just became ready\s*1/);
  assert.match(todo, /photos added, now at Waynesburg/);
  assert.equal(await tab(popup, 'todo').locator('.count').textContent(), '1');
  await popup.screenshot({ path: join(shots, '5-rescan-todo.png'), fullPage: true });

  await popup.click('button[data-action="takenDown"]');
  assert.equal(await tab(popup, 'todo').locator('.count').textContent(), '0');
  assert.equal(await tab(popup, 'mine').locator('.count').textContent(), '0');

  await popup.click('#settingsBtn');
  assert.match(await popup.textContent('.settings'), /usually \$490 higher than the price before fees/);
  await popup.screenshot({ path: join(shots, '6-settings.png') });
  await popup.close();

  // ---- Not a dealer site ----
  const other = await context.newPage();
  await other.goto('about:blank');
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.click('#scan');
  assert.match(await popup.textContent('#status'), /Open your dealership's website/);

  assert.deepEqual(errors, [], 'no console errors');
  console.log('E2E passed. Screenshots in test/e2e/screenshots/');
} finally {
  await context.close();
  server.close();
}
