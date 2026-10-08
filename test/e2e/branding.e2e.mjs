// End-to-end test of the dealer-branding crop. The mock website serves the
// Ram's 6 photos as real 640x480 PNGs with the same band laid over their
// bottom 48 rows (a photo vendor's overlay), and the Wagoneer's 6 as plain
// photos. The side panel checks the photos at review and shows each cropped
// one as it will go (the thumbnail's object-view-box, the whole width of the
// part kept on screen); the test puts photo 2
// back as the website shows it (Use original), opens the MOCK form, and reads
// back every attached file: 5 are an exact cut of the top rows without the band, one
// is the website's own 640x480. Download photos saves the same files. In a
// queue, the Ram waits at review so the person sees its cropped photos, and
// the plain Wagoneer opens its form by itself. With the setting turned off
// in the popup's Settings, the review says so and every photo goes as the
// website shows it. Nothing is ever published.
//
// The real facebook.com is never automated. Run: npm run test:e2e:branding

import { chromium } from 'playwright';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startMockSite, PHOTO_W, PHOTO_H, BAND_ROWS, BAND_COLOUR, BRANDED_VIN, PLAIN_VIN, edgeColour, photoSeed } from './mock-dealer-site.mjs';
import { startMockMarketplace, INITIAL_LISTINGS } from './mock-marketplace.mjs';
import { blockFacebook } from './noFacebook.mjs';
import { until } from './until.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const shots = join(root, 'test/e2e/screenshots');
mkdirSync(shots, { recursive: true });

// Test copy of the extension: it may script the two local mock servers and nothing else.
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
const profileDir = mkdtempSync(join(tmpdir(), 'lot-current-profile-branding-'));
const context = await chromium.launchPersistentContext(profileDir, {
  channel: process.env.LOTSYNC_E2E_CHANNEL || 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  viewport: { width: 760, height: 900 },
  acceptDownloads: true,
});
const facebook = await blockFacebook(context); // the real facebook.com is never loaded (./noFacebook.mjs)

const errors = [];
const watch = (p) => {
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  p.on('pageerror', (e) => errors.push(String(e)));
  return p;
};
// How many times Publish was clicked; and first, that nothing ever touched the
// mock form's decoy action controls or submitted it (see mock-marketplace.mjs).
const publishCount = async (p) => {
  assert.deepEqual(await (await p.request.get(`${marketOrigin}/actions`)).json(), [], 'nothing may touch an action control but the person');
  assert.deepEqual(await (await p.request.get(`${marketOrigin}/listing-actions`)).json(), [], 'nothing may mark sold, delete or update a listing but the person');
  assert.deepEqual(await (await p.request.get(`${marketOrigin}/listing-state`)).json(), INITIAL_LISTINGS, 'every listing is as it was');
  return (await p.request.get(`${marketOrigin}/publish-count`)).text();
};

const CROPPED_H = PHOTO_H - BAND_ROWS; // the band is 48 of 480 rows: a crop keeps at most the 432 above it
const near = (a, b, tol = 8) => a.every((v, k) => Math.abs(v - b[k]) <= tol);
const isBand = (px) => near(px, BAND_COLOUR);
// The form's record of every attached file (mock-marketplace.mjs): name, type, decoded size, bottom-row colours.
const attachedFiles = (fb) => fb.evaluate(() => JSON.parse(document.body.dataset.photoSizes || '[]'));
async function filesOnForm(fb, n) {
  await until(fb, (want) => JSON.parse(document.body.dataset.photoSizes || '[]').length >= want, n, { timeout: 30000, what: `${n} attached files read back` });
  return attachedFiles(fb);
}
// The four numbers of a computed object-view-box: inset(t r b l), in percent; null for none.
const insets = (img) => img.evaluate((el) => {
  const v = getComputedStyle(el).objectViewBox;
  if (!v || v === 'none') return null;
  const nums = (/^inset\((.*)\)$/.exec(v) || [])[1];
  if (!nums) return v;
  const parts = nums.trim().split(/\s+/).map((p) => Number.parseFloat(p));
  const [t, r = t, b = t, l = r] = parts;
  return [t, r, b, l];
});
const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
// What a thumbnail really shows at its left and right edges, halfway down: a
// screenshot of the img, decoded in the panel page. Each photo's outermost
// columns are a strip of its own colour (mock-dealer-site.mjs edgeColour), so
// a thumbnail trimmed to fill its box (object-fit: cover) shows the picture
// beside them instead.
async function thumbEdges(panel, img) {
  const b64 = (await img.screenshot()).toString('base64');
  return panel.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d');
    g.drawImage(bmp, 0, 0);
    const y = bmp.height >> 1;
    const at = (x) => [...g.getImageData(x, y, 1, 1).data.slice(0, 3)];
    return { left: at(1), right: at(bmp.width - 2) };
  }, b64);
}
const checkEnds = (panel, what = 'the photo check') => until(panel, () => Boolean(document.getElementById('photoPick')) && !document.getElementById('brandingProgress'), null, { timeout: 90000, what });

try {
  const ext = await context.newPage();
  await ext.goto('chrome://extensions');
  const extensionId = await ext.evaluate(async () => (await chrome.management.getAll()).find((e) => e.name === 'Lot Current').id);
  await ext.close();
  const extUrl = (file) => `chrome-extension://${extensionId}/${file}`;

  const setup = await context.newPage();
  await setup.goto(extUrl('sidepanel.html'));
  await setup.evaluate(async ({ origin, marketOrigin }) => {
    await chrome.storage.local.set({
      [`settings:${origin}`]: {
        myStores: ['Ron Lewis Chrysler Dodge Jeep Ram Waynesburg'],
        basis: 'website',
        salesperson: { name: 'Roger', title: 'sales consultant' },
        dealer: { name: 'Ron Lewis Chrysler Dodge Jeep Ram Waynesburg', city: 'Waynesburg', state: 'PA', zip: '' },
        priceNote: 'Price includes the $490 doc fee; tax and tags extra.',
        dailyCap: 10,
        rulesReadAt: new Date().toISOString(),
        rewrite: { enabled: false, endpoint: '', key: '' },
        // cropBranding is not set: the setting is on by default (src/settings.js withDefaults)
      },
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
  await dealer.request.get(`${origin}/scenario?name=branded`);
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
  async function postRam() {
    const popup = await openPopup();
    await tab(popup, 'ready').click();
    await popup.click(`button[data-action="openPost"][data-vin="${BRANDED_VIN}"]`);
    await popup.waitForFunction(() => /side panel/i.test(document.querySelector('#status').textContent));
    await popup.close();
    const panel = watch(await context.newPage());
    await panel.goto(extUrl('sidepanel.html'));
    await panel.waitForSelector('#openForm', { timeout: 20000 });
    assert.match(await panel.textContent('#vehicle'), /2019 Ram 1500 Classic Express/);
    return panel;
  }

  // ---- 1. Scan, then Post the Ram: the review checks its photos and shows the crop ----
  let popup = await openPopup();
  await popup.click('#scan');
  await popup.waitForSelector('.banner.info');
  await popup.close();
  let panel = await postRam();
  await checkEnds(panel);
  assert.equal(await panel.textContent('#branding h4'), 'Dealer branding');
  const summary = await panel.textContent('#brandingSummary');
  assert.match(summary, /^Cropped the same [^.]* off the bottom of 6 of 6 photos\./, summary);
  assert.match(summary, /Use original puts a photo back as the website shows it\./);
  assert.match(await panel.textContent('#brandingRule'), /only cuts a strip off the edges of a photo; it never paints over or changes anything in the picture/);
  assert.equal(await panel.textContent('#brandingCheck'), 'Check again');
  assert.equal(await panel.getAttribute('#photosCropAll', 'aria-pressed'), 'true');
  assert.equal(await panel.getAttribute('#photosOriginalAll', 'aria-pressed'), 'false');
  assert.equal(await panel.isDisabled('#openForm'), false, 'the form opens once the check ends');
  assert.equal(await panel.$('#formWaits'), null);
  // the check is bookkeeping kept with the post: the photos' entries, never their pixels
  await until(panel, async (o) => Boolean(((await chrome.storage.local.get(`postFlow:${o}`))[`postFlow:${o}`] || {}).branding), origin, { what: 'the check saved with the post' });
  const saved = await panel.evaluate(async (o) => (await chrome.storage.local.get(`postFlow:${o}`))[`postFlow:${o}`], origin);
  assert.equal(saved.branding.vin, BRANDED_VIN);
  assert.equal(Object.values(saved.branding.photos).filter((e) => e.status === 'cropped').length, 6);
  assert.ok(Object.values(saved.branding.photos).every((e) => /^[0-9a-f]{64}$/.test(e.sha) && !e.rgba), 'a fingerprint of the bytes, no pixels');
  assert.equal(saved.brandingRun, undefined, 'the check under way is never saved');
  // every photo is cut the same way, along the bottom, just above the band or a little more, never into the top 400 rows
  const crops = Object.values(saved.branding.photos).map((e) => e.crop);
  assert.ok(crops.every((c) => JSON.stringify(c) === JSON.stringify(crops[0])), JSON.stringify(crops));
  const cut = crops[0];
  assert.deepEqual([cut.x, cut.y, cut.w], [0, 0, PHOTO_W], JSON.stringify(cut));
  assert.ok(cut.h >= 400 && cut.h <= CROPPED_H, `the crop keeps ${cut.h} of ${PHOTO_H} rows`);
  const CUT_H = cut.h;
  const shownBottom = Math.ceil(((PHOTO_H - CUT_H) * 1000) / PHOTO_H) / 10; // src/photoBranding.js insetOf: rounded up to 0.1%
  for (let i = 0; i < 6; i++) {
    const box = await insets(panel.locator(`#photoPick li:nth-child(${i + 1}) img`));
    assert.ok(Array.isArray(box), `photo ${i + 1} shows a crop (${box})`);
    const [t, r, b, l] = box;
    assert.deepEqual([t, r, l], [0, 0, 0], `photo ${i + 1} is cut only at the bottom (${box})`);
    // the view box hides exactly the rows the crop leaves out, rounded up to a tenth of a percent: never more of the photo than goes
    assert.ok(Math.abs(b - shownBottom) < 0.01 && b >= 10, `photo ${i + 1}'s view box hides the bottom ${b}%, the crop ${shownBottom}%`);
    // and the whole width of the part that goes is on screen: the thumbnail is never trimmed again to fill its 4:3 box
    const edges = await thumbEdges(panel, panel.locator(`#photoPick li:nth-child(${i + 1}) img`));
    const colour = edgeColour(photoSeed(BRANDED_VIN, i + 1));
    assert.ok(near(edges.left, colour, 24) && near(edges.right, colour, 24), `photo ${i + 1}'s thumbnail shows its left and right edges (${JSON.stringify(edges)}, the photo's edge ${colour})`);
    assert.match(await panel.textContent(`#photoNote-${i}`), /^Cropped: .*bottom/);
    assert.equal(await panel.textContent(`#photoCrop-${i}`), 'Use original');
    assert.equal(await panel.getAttribute(`#photoCrop-${i}`, 'aria-label'), `Use original: photo ${i + 1}`);
    assert.equal(await panel.getAttribute(`#photo-${i}`, 'aria-describedby'), `photoNote-${i}`);
  }
  await panel.screenshot({ path: join(shots, 'branding-1-review.png'), fullPage: true });
  // the cover's small copy, kept on this computer for the next cars' checks
  const covers = await panel.evaluate(async (o) => (await chrome.storage.local.get(`coverSamples:${o}`))[`coverSamples:${o}`], origin);
  assert.equal(covers.version, 1);
  assert.deepEqual(covers.cars.map((c) => c.vin), [BRANDED_VIN]);
  assert.ok(covers.cars[0].w <= 128 && covers.cars[0].h <= 128, 'at most 128 pixels across');

  // ---- 2. Use original on photo 2: its thumbnail shows the whole photo, and the status line says so ----
  await panel.click('#photoCrop-1');
  await panel.waitForFunction(() => document.getElementById('photoCrop-1')?.textContent === 'Use cropped');
  assert.equal(await panel.getAttribute('#photoCrop-1', 'aria-label'), 'Use cropped: photo 2');
  assert.equal(await panel.evaluate(() => document.activeElement.id), 'photoCrop-1', 'the keyboard stays on the button');
  assert.equal(await insets(panel.locator('#photoPick li:nth-child(2) img')), null, 'photo 2 is shown whole');
  assert.match(await panel.textContent('#photoNote-1'), /^Original: /);
  assert.match(await panel.textContent('#status'), /Photo 2 goes on as the website shows it\./);
  assert.match(await panel.textContent('#brandingSummary'), /5 of 6 photos[\s\S]*You set 1 photo back to the website's original/);
  assert.equal(await panel.getAttribute('#photosCropAll', 'aria-pressed'), 'false');
  assert.equal(await panel.getAttribute('#photosOriginalAll', 'aria-pressed'), 'false');
  const savedBack = await panel.evaluate(async (o) => (await chrome.storage.local.get(`postFlow:${o}`))[`postFlow:${o}`].photoOriginals, origin);
  assert.deepEqual(savedBack.map((u) => u.split('/').pop()), ['2.png']);

  // ---- 3. Open the Marketplace form: 5 photos go cropped, photo 2 as the website shows it ----
  const [fb] = await Promise.all([context.waitForEvent('page', { timeout: 40000 }), panel.click('#openForm')]);
  watch(fb);
  await panel.waitForSelector('#confirmPosted', { timeout: 60000 });
  await panel.waitForSelector('#photos.done', { timeout: 60000 });
  const files = await filesOnForm(fb, 6);
  assert.equal(files.length, 6, JSON.stringify(files));
  files.forEach((f, i) => {
    assert.equal(f.w, PHOTO_W, `photo ${i + 1} keeps its full width`);
    if (i === 1) {
      assert.equal(f.h, PHOTO_H, 'photo 2 is the website\'s own');
      assert.ok(f.bottom.every(isBand), `photo 2 still has the band: ${JSON.stringify(f.bottom)}`);
    } else {
      assert.equal(f.h, CUT_H, `photo ${i + 1} is cut as the check found, above the band`);
      assert.ok(!f.bottom.some(isBand), `photo ${i + 1}'s bottom row is the photo, not the band: ${JSON.stringify(f.bottom)}`);
      assert.equal(f.type, 'image/png', 'a PNG stays a PNG');
    }
  });
  assert.equal(await panel.textContent('#photosCropped'), '5 cropped to take off dealer branding.');
  assert.equal(await panel.$('#photosChanged'), null);
  assert.match(await panel.textContent('#photos'), /6 of 6 attached/);
  await panel.screenshot({ path: join(shots, 'branding-2-publish.png'), fullPage: true });
  await fb.screenshot({ path: join(shots, 'branding-3-mock-form.png'), fullPage: true });

  // ---- 4. Download photos saves the same files ----
  const downloads = [];
  const onDownload = (d) => downloads.push(d);
  panel.on('download', onDownload);
  await panel.click('#downloadPhotos');
  await panel.waitForFunction(() => /6 of 6 photos downloaded to your Downloads folder\. 5 cropped to take off dealer branding\./.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  for (let i = 0; i < 50 && downloads.length < 6; i++) await panel.waitForTimeout(100);
  panel.off('download', onDownload);
  assert.equal(downloads.length, 6, 'six files saved');
  const sizes = [];
  for (const d of downloads) sizes.push({ name: d.suggestedFilename(), ...pngSize(readFileSync(await d.path())) });
  assert.deepEqual(sizes.map((s) => [s.w, s.h]), [[PHOTO_W, CUT_H], [PHOTO_W, PHOTO_H], [PHOTO_W, CUT_H], [PHOTO_W, CUT_H], [PHOTO_W, CUT_H], [PHOTO_W, CUT_H]], JSON.stringify(sizes));
  assert.ok(sizes.every((s) => /\.png$/.test(s.name)), 'named for their type');

  // ---- 5. It didn't post: back at review, the check and the choice still stand; then the post is stopped ----
  await panel.click('#notPosted');
  await panel.waitForSelector('#openForm');
  assert.equal(await panel.textContent('#photoCrop-1'), 'Use cropped');
  assert.equal(await panel.$('#brandingProgress'), null, 'no second check of the same photos');
  await fb.close();
  // Check again on a slow photo server: the form waits for the check, and Skip the check lets it go with the last check's crops standing
  await dealer.request.get(`${origin}/photo-delay?ms=4000`);
  await panel.click('#brandingCheck');
  await panel.waitForSelector('#brandingProgress');
  assert.match(await panel.textContent('#brandingProgress'), /^Checking the photos for dealer branding: \d of 6…$/);
  assert.equal(await panel.isDisabled('#openForm'), true, 'the form waits for the check');
  assert.equal(await panel.getAttribute('#openForm', 'aria-describedby'), 'formWaits');
  assert.equal(await panel.textContent('#formWaits'), 'Open the Marketplace form is ready when the photo check ends, or click Skip the check.');
  await panel.focus('#brandingStop');
  await panel.keyboard.press('Enter');
  await panel.waitForFunction(() => /Photo check skipped: the photos go on as the last check left them\./.test(document.getElementById('status').textContent));
  assert.equal(await panel.evaluate(() => document.activeElement.id), 'brandingCheck', 'the keyboard moves to the button that took its place');
  assert.equal(await panel.isDisabled('#openForm'), false);
  assert.equal(await panel.$('#formWaits'), null);
  assert.equal(await panel.textContent('#photoCrop-1'), 'Use cropped', 'the last check and the choice stand');
  await dealer.request.get(`${origin}/photo-delay?ms=0`);
  await panel.click('#stopPost');
  await panel.waitForFunction(() => /Stopped the post/.test(document.getElementById('status').textContent));
  await panel.close();
  assert.equal(await publishCount(dealer), '0', 'the extension must not publish');

  // ---- 6. A queue: the Ram waits at review for the person; the plain Wagoneer opens its form by itself ----
  popup = await openPopup();
  await popup.click('#scan');
  await popup.waitForFunction(() => /2 ready to post/.test(document.querySelector('.meta')?.textContent || ''));
  await tab(popup, 'ready').click();
  await popup.check('#pickAll');
  assert.equal(await popup.textContent('#queueBtn'), 'Post 2 cars');
  await popup.click('#queueBtn');
  await popup.waitForFunction(() => /queue/i.test(document.querySelector('#status').textContent));
  await popup.close();
  const pagesBefore = context.pages().length;
  panel = watch(await context.newPage());
  await panel.goto(extUrl('sidepanel.html'));
  await panel.waitForSelector('#openForm', { timeout: 30000 });
  assert.match(await panel.textContent('#vehicle'), /2019 Ram 1500 Classic Express/);
  assert.match(await panel.textContent('#queueBar'), /Car 1 of 2/);
  await checkEnds(panel, "the queued Ram's photo check");
  await panel.waitForTimeout(1500); // time for a form that would open by itself
  assert.equal(await panel.$('#confirmPosted'), null, 'the Ram waits at review: its photos were cropped');
  assert.equal(context.pages().length, pagesBefore + 1, 'no form tab opened for it');
  assert.equal(await panel.isDisabled('#openForm'), false, 'the person opens it when ready');
  assert.match(await panel.textContent('#brandingSummary'), /off the bottom of 6 of 6 photos/);
  assert.equal(await panel.textContent('#photoCrop-1'), 'Use original', "a new post: the last post's choice is not carried over");
  await panel.screenshot({ path: join(shots, 'branding-4-queue-waits.png'), fullPage: true });
  const fbPromise = context.waitForEvent('page', { timeout: 60000 });
  await panel.click('#queueSkip');
  const fb2 = watch(await fbPromise);
  await panel.waitForSelector('#confirmPosted', { timeout: 60000 });
  await panel.waitForSelector('#photos.done', { timeout: 60000 });
  assert.match(await panel.textContent('#vehicle'), /2022 Jeep Wagoneer Series III/);
  assert.equal(await fb2.inputValue('#vin'), PLAIN_VIN);
  const plain = await filesOnForm(fb2, 6);
  assert.deepEqual(plain.map((f) => [f.w, f.h]), Array(6).fill([PHOTO_W, PHOTO_H]), 'plain photos go as the website shows them');
  assert.equal(await panel.$('#photosCropped'), null);
  const plainFlow = await panel.evaluate(async (o) => (await chrome.storage.local.get(`postFlow:${o}`))[`postFlow:${o}`], origin);
  assert.ok(Object.values(plainFlow.branding.photos).every((e) => e.status === 'none'), 'nothing found on the plain photos');
  // two cars' covers now, newest first
  const covers2 = await panel.evaluate(async (o) => (await chrome.storage.local.get(`coverSamples:${o}`))[`coverSamples:${o}`], origin);
  assert.deepEqual(covers2.cars.map((c) => c.vin), [PLAIN_VIN, BRANDED_VIN]);
  await panel.click('#skipCar'); // as the person would, without publishing: the queue is done
  await panel.waitForSelector('#queueDone', { timeout: 20000 });
  assert.match(await panel.textContent('#queueDone'), /2 skipped/);
  await panel.click('#queueClear');
  await panel.waitForFunction(() => !document.getElementById('queueBar'));
  await fb2.close();
  await panel.close();
  assert.equal(await publishCount(dealer), '0', 'the extension must not publish');

  // ---- 7. The setting turned off in Settings while the Ram is at review: the photos go as the website shows them ----
  panel = await postRam();
  await checkEnds(panel);
  assert.ok(await panel.$('#photoCrop-0'), 'checked and cropped with the setting on');
  popup = await openPopup();
  await popup.click('#settingsBtn');
  const box = popup.locator('input[name="cropBranding"]');
  assert.equal(await box.isChecked(), true, 'on by default');
  assert.match(await popup.textContent('.settings'), /Crop the website's dealer branding off the photos[\s\S]*You see each photo before you post and can use the original\. Lot Current only cuts a strip off the edges; it never paints over anything\./);
  await box.uncheck();
  await popup.click('#panel button[type="submit"]');
  await popup.waitForFunction(() => (document.querySelector('#saved')?.textContent || '').length > 0);
  const stored = await popup.evaluate(async (o) => (await chrome.storage.local.get(`settings:${o}`))[`settings:${o}`], origin);
  assert.equal(stored.cropBranding, false);
  await popup.close();
  await panel.waitForSelector('#brandingOff');
  assert.equal(await panel.textContent('#brandingOff'), 'Cropping dealer branding off the photos is off for this website (Settings).');
  assert.equal(await panel.$('#photoCrop-0'), null);
  assert.equal(await panel.$('#brandingSummary'), null);
  for (let i = 0; i < 6; i++) assert.equal(await insets(panel.locator(`#photoPick li:nth-child(${i + 1}) img`)), null, `photo ${i + 1} is shown whole`);
  await panel.screenshot({ path: join(shots, 'branding-5-off.png'), fullPage: true });
  const [fb3] = await Promise.all([context.waitForEvent('page', { timeout: 40000 }), panel.click('#openForm')]);
  watch(fb3);
  await panel.waitForSelector('#photos.done', { timeout: 60000 });
  const whole = await filesOnForm(fb3, 6);
  assert.deepEqual(whole.map((f) => [f.w, f.h]), Array(6).fill([PHOTO_W, PHOTO_H]), 'every photo as the website shows it');
  assert.ok(whole.every((f) => f.bottom.every(isBand)));
  assert.equal(await panel.$('#photosCropped'), null);
  await fb3.close();
  await panel.close();

  assert.equal(await publishCount(dealer), '0', 'nothing was ever published');
  assert.deepEqual(errors, [], 'no console errors');
  facebook.assertNone();
  console.log('Branding E2E passed. Screenshots in test/e2e/screenshots/');
} finally {
  await context.close();
  for (const d of [profileDir, extDir]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { /* still locked by the closing browser; every run makes its own folders, so a leftover does no harm */ } }
  site.close();
  market.close();
}
