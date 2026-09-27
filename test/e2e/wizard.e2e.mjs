// End-to-end test of the first-run wizard and the background rescan: a fresh
// profile with no settings -> the popup offers set-up -> the side panel walks
// the steps (read the website, store, name, address from the site's own
// structured data, permission for automatic rescans, the posting rules) ->
// Ready to post is right -> the salesperson marks a car posted -> the mock
// site "sells" it -> the service worker rescans it by calling the inventory
// service directly (no tab) -> the badge shows 1 and the popup's To do agrees.
//
// The real facebook.com is never automated. Run: npm run test:e2e:wizard

import { chromium } from 'playwright';
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startMockSite } from './mock-dealer-site.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const shots = join(root, 'test/e2e/screenshots');
mkdirSync(shots, { recursive: true });

const extDir = join(tmpdir(), 'lot-sync-ext-under-test-wizard');
rmSync(extDir, { recursive: true, force: true });
cpSync(join(root, 'extension'), extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
manifest.permissions = manifest.permissions.filter((p) => p !== 'sidePanel'); // no real side panel in tests
delete manifest.side_panel;
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const site = await startMockSite();
const siteUrl = `http://127.0.0.1:${site.address().port}/used-vehicles/`;
const origin = new URL(siteUrl).origin;
const context = await chromium.launchPersistentContext(join(tmpdir(), 'lot-sync-profile-wizard-' + Date.now()), {
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

try {
  const ext = await context.newPage();
  await ext.goto('chrome://extensions');
  const extensionId = await ext.evaluate(async () => (await chrome.management.getAll()).find((e) => e.name === 'Lot Sync').id);
  await ext.close();
  const extUrl = (file) => `chrome-extension://${extensionId}/${file}`;

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

  // ---- 1. A fresh profile: the popup offers set-up ----
  let popup = await openPopup();
  await popup.waitForSelector('#setup');
  await popup.click('button[data-action="setup"]');
  await popup.waitForFunction(() => /side panel/i.test(document.querySelector('#status').textContent));
  await popup.close();

  // ---- 2. The wizard, step by step ----
  const panel = watch(await context.newPage());
  panelRef = panel;
  await panel.goto(extUrl('sidepanel.html'));
  await panel.waitForSelector('#wizNext');
  assert.match(await panel.textContent('#panel'), /Set up Lot Sync for this dealership/);
  await panel.click('#wizNext'); // -> read the website (runs by itself)
  await panel.waitForSelector('.banner.good', { timeout: 30000 });
  assert.match(await panel.textContent('.banner.good'), /6 used cars read from Ron Lewis Chrysler Dodge Jeep Ram Waynesburg\. 3 stores found\./);
  await panel.screenshot({ path: join(shots, 'wizard-1-read.png') });
  await panel.click('#wizNext'); // -> store
  const stores = await panel.$$eval('.wizStore', (boxes) => boxes.map((b) => `${b.value}=${b.checked}`));
  assert.deepEqual(stores, ['Ron Lewis Chrysler Dodge Jeep Ram Cranberry=false', 'Ron Lewis Chrysler Dodge Jeep Ram Pleasant Hills=false', 'Ron Lewis Chrysler Dodge Jeep Ram Waynesburg=true'], 'the store matching the site name is pre-ticked');
  await panel.click('#wizNext'); // -> you
  await panel.fill('#wizName', 'Roger');
  await panel.click('#wizNext'); // -> address
  assert.equal(await panel.inputValue('#wizCity'), 'Waynesburg');
  assert.equal(await panel.inputValue('#wizState'), 'PA');
  assert.equal(await panel.inputValue('#wizZip'), '15370', "from the website's structured data");
  await panel.click('#wizNext'); // -> permission
  assert.match(await panel.textContent('#panel'), /Automatic rescans/);
  await panel.click('#wizGrant'); // the test copy already has this host; Chrome answers without a prompt
  await panel.waitForSelector('.banner.good');
  assert.match(await panel.textContent('.banner.good'), /Permission granted/);
  await panel.click('#wizNext'); // -> rules
  assert.match(await panel.textContent('ol.rules'), /You publish every post\.[\s\S]*Ads law applies\./);
  assert.equal(await panel.isDisabled('#wizFinish'), true);
  await panel.check('#wizRulesRead');
  assert.equal(await panel.isDisabled('#wizFinish'), false);
  await panel.screenshot({ path: join(shots, 'wizard-2-rules.png'), fullPage: true });
  await panel.click('#wizFinish');
  await panel.waitForFunction(() => /Set up\./.test(document.querySelector('.banner.good')?.textContent || ''), null, { timeout: 30000 });
  assert.match(await panel.textContent('.banner.good'), /1 car is ready to post[\s\S]*Automatic rescans are on/);
  await panel.screenshot({ path: join(shots, 'wizard-3-done.png') });

  const saved = await panel.evaluate(async (o) => {
    const all = await chrome.storage.local.get(null);
    const s = all[`settings:${o}`];
    const alarm = await chrome.alarms.get('lot-sync-rescan');
    return { name: s.salesperson.name, stores: s.myStores, zip: s.dealer.zip, autoRescan: s.autoRescan, notify: s.notify, rulesRead: Boolean(s.rulesReadAt), wizardDone: Boolean(all[`wizardDone:${o}`]), siteAuto: all.sites[o].auto, service: all.sites[o].service.search, alarmMinutes: alarm && alarm.periodInMinutes };
  }, origin);
  assert.deepEqual(saved, { name: 'Roger', stores: ['Ron Lewis Chrysler Dodge Jeep Ram Waynesburg'], zip: '15370', autoRescan: true, notify: true, rulesRead: true, wizardDone: true, siteAuto: true, service: `${origin}/api/v1/listings/153146`, alarmMinutes: 180 });
  await panel.click('#wizClose');

  // ---- 3. The popup is ready to use; mark the Ram posted ----
  popup = await openPopup();
  assert.equal(await popup.$('#setup'), null, 'set-up is no longer offered');
  assert.equal(await tab(popup, 'ready').locator('.count').textContent(), '1');
  await tab(popup, 'ready').click();
  await popup.click('button[data-action="post"]'); // Mark posted
  await popup.waitForSelector('button[data-action="unpost"]');

  // ---- 4. The car sells; the service worker rescans with no tab, and the badge shows the to-do ----
  await dealer.request.get(`${origin}/scenario?name=day2`);
  const rescan = await popup.evaluate((o) => chrome.runtime.sendMessage({ type: 'rescanNow', origin: o, reason: 'test' }), origin);
  assert.deepEqual({ ok: rescan.ok, count: rescan.count, cars: rescan.cars }, { ok: true, count: 1, cars: 6 });
  assert.equal(await popup.evaluate(() => chrome.action.getBadgeText({})), '1');
  await popup.close();
  popup = await openPopup(); // reopening shows the rescan's result
  assert.equal(await tab(popup, 'todo').locator('.count').textContent(), '1');
  const todo = await popup.textContent('.panel');
  assert.match(todo, /Take down\s*1/);
  assert.match(todo, /2019 Ram 1500 Classic Express.*Gone from the website/);
  await popup.screenshot({ path: join(shots, 'wizard-4-badge-todo.png') });
  await popup.click('button[data-action="takenDown"]');
  await popup.waitForFunction(() => document.querySelector('.tabs button[data-view="todo"] .count').textContent === '0');
  await popup.waitForFunction(async () => (await chrome.action.getBadgeText({})) === '');
  await popup.close();
  await panel.close();

  assert.deepEqual(errors, [], 'no console errors');
  console.log('Wizard E2E passed. Screenshots in test/e2e/screenshots/');
} catch (e) {
  if (panelRef && !panelRef.isClosed()) {
    console.error('Panel text:', (await panelRef.textContent('#panel').catch(() => '')).replace(/\s+/g, ' ').slice(0, 600));
    await panelRef.screenshot({ path: join(shots, 'wizard-failure.png'), fullPage: true }).catch(() => {});
  }
  console.error('Console errors:', errors);
  throw e;
} finally {
  await context.close();
  site.close();
}
