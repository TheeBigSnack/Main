// End-to-end test of the batch queue: tick two ready cars in the popup and
// click "Post 2 cars". The side panel then walks them one at a time: re-check,
// describe, open and fill the MOCK form. The test clicks Publish on the first
// car as the salesperson would; the panel notices the listing address, reads
// the page, sees the car's VIN on it, records it and loads the next car by
// itself. The second car is a mild hybrid (the website says "Gasoline/Mild
// Electric Hybrid"), so its fuel is an assumption: the queue stops at review
// with it listed, and the test clicks Open the Marketplace form as the person
// would. Its form tab then goes straight to another car's listing (as a
// clicked notification would take it): nothing is recorded, the panel says
// it couldn't confirm the page shows this car, and the Listing link box
// stays empty, also once the panel is closed and opened again (it reads the
// page again and never says it posted). For the second car the test presses
// "Saved as draft" (as if the person used Facebook's Save draft), and the
// queue finishes with 1 posted, 1 draft. Then the website drops the draft's
// car $1,500: the draft's pill says so, and Mark posted (after that scan)
// records the price the draft shows, with the drop listed under Update price
// and on My listings, where Updated offers the website's price.
//
// The real facebook.com is never automated. Run: npm run test:e2e:queue

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
const profileDir = mkdtempSync(join(tmpdir(), 'lot-current-profile-queue-'));
const context = await chromium.launchPersistentContext(profileDir, {
  channel: process.env.LOTSYNC_E2E_CHANNEL || 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  viewport: { width: 760, height: 900 },
});
const facebook = await blockFacebook(context); // the real facebook.com is never loaded (./noFacebook.mjs)

const errors = [];
let panelRef = null;
const watch = (p) => {
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  p.on('pageerror', (e) => errors.push(String(e)));
  return p;
};
// How many times Publish was clicked; and first, that nothing ever touched the
// mock form's decoy action controls or submitted it (see mock-marketplace.mjs).
const publishCount = async (p) => {
  assert.deepEqual(await (await p.request.get(`${marketOrigin}/actions`)).json(), [], 'nothing may touch an action control but the person');
  // nor did anything mark a listing sold, delete one or save an edit: Facebook lands on a listing page after Publish
  assert.deepEqual(await (await p.request.get(`${marketOrigin}/listing-actions`)).json(), [], 'nothing may mark sold, delete or update a listing but the person');
  assert.deepEqual(await (await p.request.get(`${marketOrigin}/listing-state`)).json(), INITIAL_LISTINGS, 'every listing is as it was');
  return (await p.request.get(`${marketOrigin}/publish-count`)).text();
};
const RAM = '1C6RR7FT0KS643289';
const WAGONEER = '1C4SJVDT7NS142834';

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
        // every store, chosen in Settings with the stores in view: the website's first scan keeps that choice
        // (src/scanRunner.js), so the ready cars at both stores are queued
        myStores: [],
        storesChosen: true,
        basis: 'website',
        salesperson: { name: 'Roger', title: 'sales consultant' },
        dealer: { name: 'Ron Lewis Chrysler Dodge Jeep Ram Waynesburg', city: '', state: '', zip: '' }, // filled from the website's own address
        priceNote: 'Price includes the $490 doc fee; tax and tags extra.',
        dailyCap: 10,
        rulesReadAt: new Date().toISOString(), // set-up's posting rules, ticked (the side panel asks first otherwise: test/e2e/panel.e2e.mjs)
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

  // `at`: the moment this popup reads as now (step 6 on), so a run that crosses midnight still
  // counts the day's post and draft as today's
  async function openPopup({ at = null } = {}) {
    const popup = watch(await context.newPage());
    if (at) await popup.clock.setFixedTime(at);
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
  assert.match(changed, /Facebook changed[\s\S]*after Lot Current filled it/);
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

  // Before publishing, the person follows a link from the form page to another car's listing (a
  // Wagoneer Series II, VIN 1C4SJVBT0NS000616): the tab went straight from the form to a listing
  // not yet recorded, but the page doesn't show this car, so nothing is recorded and the panel asks.
  // While the page is read, the panel says so, never "Looks like it posted", and offers no link.
  const NOT_CONFIRMED = /couldn't confirm that it shows 2022 Jeep Wagoneer Series III/;
  // what the panel shows, every 100 ms, until it has said it is reading the page and then that it
  // couldn't confirm the page shows this car
  const watchBanner = async () => {
    const seen = [];
    for (let i = 0; i < 400; i += 1) {
      const now = await panel.evaluate(() => ({ banner: document.querySelector('#detected')?.textContent || '', box: document.querySelector('#listingUrl')?.value ?? null }));
      seen.push(now);
      const read = seen.findIndex((v) => /is reading it \(only reading\)/.test(v.banner));
      if (read >= 0 && seen.slice(read).some((v) => /couldn't confirm/.test(v.banner))) return seen;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`the panel never read the page and said it couldn't confirm it: ${JSON.stringify(seen.slice(-3))}`);
  };
  await fb2.goto(`${marketOrigin}/marketplace/item/616161/`);
  const firstLook = await watchBanner();
  for (const v of firstLook) {
    assert.doesNotMatch(v.banner, /Looks like it posted/, 'never said to have posted');
    assert.ok(!v.box, `no link offered while the page is read (${JSON.stringify(v)})`);
  }
  assert.match(await panel.textContent('#detected'), NOT_CONFIRMED);
  assert.match(await panel.textContent('#detected'), /\(its VIN, or its name at \$38,383\), so the queue did not record it by itself/);
  assert.match(await panel.textContent('#queueBar'), /Car 2 of 2/);
  assert.match(await panel.textContent('#queueBar'), /1 posted/);
  assert.equal(await panel.inputValue('#listingUrl'), '', "the other car's listing is not offered as this car's link");
  const posted2 = await panel.evaluate(async (o) => (await chrome.storage.local.get(`posted:${o}`))[`posted:${o}`], origin);
  assert.deepEqual(Object.keys(posted2), [RAM], 'the Wagoneer is not recorded as posted');
  await panel.screenshot({ path: join(shots, 'queue-2c-not-this-car.png'), fullPage: true });
  // The panel is closed and opened again with the tab still on that listing: it reads the page
  // again, and at no point says it posted or offers that listing's address as this car's link.
  await panel.reload();
  const again = await watchBanner();
  for (const v of again) {
    assert.doesNotMatch(v.banner, /Looks like it posted/, 'reopened: never said to have posted');
    assert.ok(!v.box, `reopened: no link offered (${JSON.stringify(v)})`);
  }
  assert.match(await panel.textContent('#detected'), NOT_CONFIRMED);
  assert.equal(await panel.inputValue('#listingUrl'), '');
  assert.deepEqual(Object.keys(await panel.evaluate(async (o) => (await chrome.storage.local.get(`posted:${o}`))[`posted:${o}`], origin)), [RAM]);

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

  // ---- 6. At the daily cap nothing more can be selected or posted; the form saved as a draft counts ----
  // The cap counts the local day's posts, and a run can cross midnight after the post in step 3. So
  // the post, its entry in the day's log and the draft are stamped with one moment, noon today, and the
  // popups from here on read the clock at that moment or a moment after it: all of them fall on one day,
  // whenever the run is.
  const capDay = new Date();
  capDay.setHours(12, 0, 0, 0);
  await popup.evaluate(async ({ o, at }) => {
    const k = `settings:${o}`;
    const s = (await chrome.storage.local.get(k))[k];
    s.dailyCap = 2; // one post and one form saved as a draft today
    const keys = { posted: `posted:${o}`, log: `postLog:${o}`, drafts: `drafts:${o}` };
    const all = await chrome.storage.local.get(Object.values(keys));
    const posted = all[keys.posted];
    for (const e of Object.values(posted)) e.postedAt = at;
    const log = (all[keys.log] || []).map((e) => ({ ...e, at }));
    const drafts = all[keys.drafts];
    for (const d of Object.values(drafts)) d.savedAt = at;
    await chrome.storage.local.set({ [k]: s, [keys.posted]: posted, [keys.log]: log, [keys.drafts]: drafts });
  }, { o: origin, at: capDay.toISOString() });
  await popup.close();
  popup = await openPopup({ at: capDay });
  await tab(popup, 'ready').click();
  assert.match(await popup.textContent('#capReached'), /Daily post cap reached \(2 of 2 today, one of them saved as a draft\)/);
  assert.equal(await popup.locator('.pick').count(), 0, 'no boxes to tick');
  assert.equal(await popup.locator('#queueBtn').count(), 0);
  assert.equal(await popup.locator('button[data-action="openPost"]:not([disabled])').count(), 0, 'Post buttons are disabled');
  await popup.screenshot({ path: join(shots, 'queue-5-cap-reached.png') });
  await popup.close();

  // ---- 7. The website drops the Wagoneer $1,500 while its draft waits; the person publishes the draft and marks it posted ----
  // The draft still says $38,383, so that is what the listing shows: it is recorded at that price and To do lists the drop at once.
  await dealer.request.get(`${origin}/scenario?name=day2`);
  popup = await openPopup({ at: capDay }); // the draft is today's, so Mark posted does not ask when it went up
  await popup.click('#scan');
  await popup.waitForSelector('h3');
  assert.match(await popup.textContent('.panel'), /Update price\s*1[\s\S]*Jeep Wagoneer[\s\S]*Not marked as posted/);
  await tab(popup, 'ready').click();
  const draftPill = popup.locator('.pill', { hasText: 'Draft on Facebook' });
  assert.equal(await draftPill.textContent(), 'Draft on Facebook at $38,383: the website now shows $36,883');
  assert.match(await draftPill.getAttribute('class'), /\bbad\b/);
  assert.match(await draftPill.getAttribute('title'), /^Change the price on the draft to \$36,883 before you publish it\./);
  await popup.screenshot({ path: join(shots, 'queue-6-draft-price-changed.png') });
  await popup.close();
  // published since that scan and marked posted a moment later: the listing got its price when the draft was filled,
  // no later than the scan (src/drafts.js markDraftPosted, src/rescan.js scanCar), so the scan's price is the one to take now
  popup = await openPopup({ at: new Date(capDay.getTime() + 1) });
  await tab(popup, 'ready').click();
  await popup.click(`button[data-action="post"][data-vin="${WAGONEER}"]`);
  await popup.waitForFunction(() => /^Recorded at/.test(document.querySelector('#status').textContent));
  assert.equal(await popup.textContent('#status'), 'Recorded at $38,383, the price the draft was filled with. The website now shows $36,883: update the price on the listing (To do, Update price).');
  const recorded = await popup.evaluate(async ({ o, vin }) => (await chrome.storage.local.get(`posted:${o}`))[`posted:${o}`][vin].price, { o: origin, vin: WAGONEER });
  assert.equal(recorded, 38383, 'the price the published draft shows');
  await tab(popup, 'todo').click();
  const todo = await popup.textContent('.panel');
  assert.match(todo, /Update price\s*1[\s\S]*Jeep Wagoneer[\s\S]*Your listing[\s\S]*\$38,383 → \$36,883/);
  assert.equal(await popup.locator(`button[data-action="upkeep"][data-kind="price"][data-vin="${WAGONEER}"]`).count(), 1, 'Open & update price is offered');
  await tab(popup, 'mine').click();
  const mine = popup.locator('.row', { hasText: 'Wagoneer' });
  assert.match(await mine.textContent(), /Website price changed[\s\S]*Listed \$38,383\s*Website \$36,883/, 'My listings shows the drop To do lists');
  assert.equal(await mine.locator('button[data-action="priceUpdated"][data-price="36883"]').count(), 1, 'with Updated at the website\'s price');
  await popup.close();
  // and the next rescan still lists it, until the listing is updated
  popup = await openPopup({ at: capDay });
  await popup.click('#scan');
  await popup.waitForSelector('h3');
  assert.match(await popup.textContent('.panel'), /Update price\s*1[\s\S]*Jeep Wagoneer[\s\S]*Your listing[\s\S]*\$38,383 → \$36,883/);
  await popup.close();
  await panel.close();

  assert.equal(await publishCount(dealer), '1', 'still only the person\'s one click, and no listing marked sold, deleted or edited since');
  assert.deepEqual(errors, [], 'no console errors');
  facebook.assertNone();
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
