// Takes the landing page's product screenshots from the in-browser sandbox
// (demo/) with its sample data, in headless Chromium at 1280 x 800: the popup
// after a scan, the side panel's description and checks, the sample
// Marketplace form filled in, the To do tab after day 2, and the Pilot tab.
// The steps are demo/drive.mjs's without its assertions. The clicks on
// Publish, Edit listing, Update and Mark as sold stand in for the person;
// the extension never makes them, and the sample Marketplace counts them.
//
// Run:  npm run screenshots        -> site/screenshots/*.png
// Needs the repo's Playwright (npm ci) and a Chromium: LOTSYNC_CHROME=<path>
// to a Chrome/Chromium binary, else the one Playwright installed
// (npx playwright install chromium).
//
// The images are drafts for the landing page and the store listing: they
// show the sandbox's sample dealership and sample form, not a real one
// (store/listing.md, Screenshots). Every file is checked to be exactly
// 1280 x 800; a file over SIZE_LIMIT is reported so it can be swapped for a
// JPEG (page.screenshot's type and quality options) before it ships.

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../demo/serve.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const shots = join(root, 'site/screenshots');
mkdirSync(shots, { recursive: true });

const WIDTH = 1280;
const HEIGHT = 800;
const SIZE_LIMIT = 400 * 1024;

const DEFAULT_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath = process.env.LOTSYNC_CHROME || (existsSync(DEFAULT_CHROME) ? DEFAULT_CHROME : undefined);

const server = await startServer({ port: 0 });
const url = `http://127.0.0.1:${server.address().port}/demo/`;
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() >= 400 && !/favicon\.ico$/.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`); });

const F150 = '1FTSAMPL9LE000001';
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
async function closePopup() {
  if (await page.locator('#popupHost').isVisible()) await page.click('#lotSyncButton');
  await page.locator('#popupHost').waitFor({ state: 'hidden' });
}
// The side panel gets a green ring for a second when it opens; the shot waits for it to fade.
const settled = () => page.locator('#sidepanel:not(.flash)').waitFor();

// Width and height from the PNG's IHDR chunk, so a wrong viewport cannot ship quietly.
function pngSize(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const written = [];
async function shot(name) {
  const file = join(shots, name);
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
  const { width, height } = pngSize(readFileSync(file));
  if (width !== WIDTH || height !== HEIGHT) throw new Error(`${name} is ${width} x ${height}, not ${WIDTH} x ${HEIGHT}`);
  written.push({ name, width, height, bytes: statSync(file).size });
}

// A person publishes on the sample form, then records it in the panel.
async function publishAndRecord(tabId) {
  await tab(tabId).locator('#publish').click(); // the person
  await panel.locator('#detected').waitFor({ timeout: 15000 });
  await panel.locator('#confirmPosted').click();
  await panel.locator('#done').waitFor();
}

try {
  await page.goto(url);
  await waitReady();
  // Fold the how-to so the browser pane and the popup get the height they need.
  await page.locator('#howto summary').click();

  // ---- 1. Scan the sample website: the popup's Ready to post tab ----
  await openPopup();
  await popup.locator('#scan').click();
  await popup.locator('.banner.info').waitFor({ timeout: 20000 });
  await popupTab('ready').click();
  await popup.locator(`button[data-action="openPost"][data-vin="${F150}"]`).waitFor();
  await shot('01-ready-to-post.png');

  // ---- 2. Post the F-150: the side panel re-checks it and writes the description ----
  await popup.locator(`button[data-action="openPost"][data-vin="${F150}"]`).click();
  await panel.locator('#openForm').waitFor({ timeout: 20000 });
  await panel.locator('#checks').filter({ hasText: /All checks passed/ }).waitFor();
  await closePopup(); // the website's car is behind it
  await settled();
  await shot('02-side-panel.png');

  // ---- 3. The sample Marketplace form fills itself in, photos included; Publish is the person's ----
  await panel.locator('#openForm').click();
  const form = await tabFrame(2);
  await panel.locator('#confirmPosted').waitFor({ timeout: 40000 });
  await panel.locator('#photos.done').waitFor({ timeout: 40000 });
  await form.evaluate(() => window.scrollTo(0, 0)); // the filling scrolled the form; show it from the photos down
  await page.locator('#popupHost').waitFor({ state: 'hidden' });
  await shot('03-form-filled.png');
  await publishAndRecord(2);

  // ---- 4. A second post (the Civic), so day 2 has a sold car and a price drop on the person's own listings ----
  await openPopup();
  await popupTab('ready').click();
  await popup.locator(`button[data-action="openPost"][data-vin="${CIVIC}"]`).click();
  await panel.locator('#openForm').waitFor({ timeout: 20000 });
  await panel.locator('#openForm').click();
  await tabFrame(3);
  await panel.locator('#confirmPosted').waitFor({ timeout: 40000 });
  await panel.locator('#photos.done').waitFor({ timeout: 40000 });
  await publishAndRecord(3);

  // ---- 5. Day 2: the website sells the F-150 and drops the Civic's price; the rescan's To do tab ----
  await page.click('[data-tab="1"]'); // back to the website tab, behind the popup
  await page.click('#day2');
  await tab(1).locator('[id="5XYSAMPL2ME000011"]').waitFor(); // the arrival's card on the sample website
  await openPopup();
  await popup.locator('#scan').click();
  await popup.locator('h3').first().waitFor({ timeout: 20000 });
  await popupTab('todo').click();
  await popup.locator('button[data-action="upkeep"][data-kind="takeDown"]').waitFor();
  await page.waitForFunction(() => document.getElementById('badge').textContent === '2', null, { timeout: 5000 });
  await shot('04-to-do.png');

  // ---- 6. The person fixes both: Edit listing and Update for the price, Mark as sold for the sold car ----
  await popup.locator('button[data-action="upkeep"][data-kind="price"]').click();
  await tabFrame(4);
  await panel.locator('#priceWaiting').waitFor({ timeout: 20000 });
  await closePopup(); // it covers the listing at this width, as a click on the page would close it
  await tab(4).locator('text=Edit listing').click(); // the person
  await panel.locator('#priceFilled').waitFor({ timeout: 20000 });
  await tab(4).locator('#update').click(); // the person
  await panel.locator('#upkeepDone').waitFor({ timeout: 20000 });
  await panel.locator('#upkeepClose').click();
  await openPopup();
  await popupTab('todo').click();
  await popup.locator('button[data-action="upkeep"][data-kind="takeDown"]').click();
  const sold = await tabFrame(5);
  await panel.locator('#takeDownWaiting').waitFor({ timeout: 20000 });
  await closePopup();
  await sold.waitForLoadState();
  await page.waitForTimeout(3500); // the panel reads the page once first (its baseline), as in demo/drive.mjs
  await tab(5).locator('text=Mark as sold').click(); // the person
  await panel.locator('#upkeepDone').waitFor({ timeout: 20000 });
  await panel.locator('#upkeepClose').click();

  // ---- 7. The Pilot tab: two posts timed, every field filled, both to-do items fixed ----
  await openPopup();
  await popupTab('pilot').click();
  await popup.locator('.panel').filter({ hasText: /Posted through Lot Sync/ }).waitFor();
  await shot('05-pilot.png');

  const clicks = await page.evaluate(() => Number(sessionStorage.getItem('lotSyncSandbox.publishClicks') || 0));
  if (clicks !== 2) throw new Error(`expected the person's 2 clicks on Publish, the sample form counted ${clicks}`);
  if (errors.length) throw new Error('the sandbox reported errors:\n' + errors.join('\n'));

  for (const s of written) {
    const kb = (s.bytes / 1024).toFixed(0);
    const note = s.bytes > SIZE_LIMIT ? `  OVER ${SIZE_LIMIT / 1024} KB: switch this one to JPEG (type: 'jpeg', quality) and update site/index.html` : '';
    console.log(`${relative(root, join(shots, s.name))}: ${s.width} x ${s.height}, ${kb} KB${note}`);
  }
} catch (e) {
  await page.screenshot({ path: join(shots, 'failure.png'), fullPage: true }).catch(() => {});
  console.error('Panel:', (await panel.locator('#panel').textContent().catch(() => '')).replace(/\s+/g, ' ').slice(0, 600));
  console.error('Popup status:', await popup.locator('#status').textContent().catch(() => ''));
  console.error('Errors:', errors);
  throw e;
} finally {
  await browser.close();
  server.close();
}
