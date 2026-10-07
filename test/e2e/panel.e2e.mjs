// End-to-end test of posting from the side panel's own list, with the
// dealership website closed: scan once from the popup, close the dealer tab,
// then everything happens in the panel. Its Ready to post list (search, sort,
// the website choice), Post on a car that sold since the scan (the re-check
// reads the website straight from the extension and stops it), Post on a car
// whose price dropped (posted at the website's new price), the MOCK form
// filled, the test clicking Publish as the salesperson would (the extension
// never does), Post another car, Rescan the website from the panel, "Post the
// next N" as a queue, a copy of a post another window's side panel changed
// since (the save refused here is said, the text typed here kept to copy,
// and Back to the list leaves that window's post), and the daily cap taking
// the Post buttons away.
//
// The real facebook.com is never automated. Screenshots go to test/e2e/screenshots/.
// Run: npm run test:e2e:panel   (needs Playwright + Chromium installed)

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
// nothing else (see post.e2e.mjs).
const extDir = mkdtempSync(join(tmpdir(), 'lot-current-ext-'));
cpSync(join(root, 'extension'), extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
manifest.permissions = manifest.permissions.filter((p) => p !== 'sidePanel');
delete manifest.side_panel;
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const site = await startMockSite();
const market = await startMockMarketplace();
const siteUrl = `http://127.0.0.1:${site.address().port}/used-vehicles/`;
const origin = new URL(siteUrl).origin;
const marketOrigin = `http://127.0.0.1:${market.address().port}`;
const profileDir = mkdtempSync(join(tmpdir(), 'lot-current-profile-panel-'));
const context = await chromium.launchPersistentContext(profileDir, {
  channel: process.env.LOTSYNC_E2E_CHANNEL || 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  viewport: { width: 520, height: 900 },
});
const facebook = await blockFacebook(context); // the real facebook.com is never loaded (./noFacebook.mjs)

const errors = [];
const watch = (p) => {
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  p.on('pageerror', (e) => errors.push(String(e)));
  return p;
};
const RAM = '1C6RR7FT0KS643289';
const WAGONEER = '1C4SJVDT7NS142834';
const HELLCAT = '2C3CDZC96GH308445';
const SILVERADO = '3GCUYGED0MG244585';

try {
  const ext = await context.newPage();
  await ext.goto('chrome://extensions');
  const extensionId = await ext.evaluate(async () => (await chrome.management.getAll()).find((e) => e.name === 'Lot Current').id);
  await ext.close();
  const extUrl = (file) => `chrome-extension://${extensionId}/${file}`;
  const get = async (path) => (await context.request.get(`${path.startsWith('http') ? '' : origin}${path}`)).text();
  // How many times Publish was clicked; and first, that nothing ever touched the
  // mock form's decoy action controls or submitted it (see mock-marketplace.mjs).
  const publishCount = async () => {
    assert.deepEqual(await (await context.request.get(`${marketOrigin}/actions`)).json(), [], 'nothing may touch an action control but the person');
    // nor did anything mark a listing sold, delete one or save an edit: Facebook lands on a listing page after Publish
    assert.deepEqual(await (await context.request.get(`${marketOrigin}/listing-actions`)).json(), [], 'nothing may mark sold, delete or update a listing but the person');
    assert.deepEqual(await (await context.request.get(`${marketOrigin}/listing-state`)).json(), INITIAL_LISTINGS, 'every listing is as it was');
    return (await context.request.get(`${marketOrigin}/publish-count`)).text();
  };

  // Settings and the test hooks straight into storage. Both stores are the
  // salesperson's, so the Ram (Waynesburg) and the Wagoneer (Cranberry) are
  // both ready. Named, not left empty: the website's first scan ticks only
  // the store named after it when none is chosen (src/scanRunner.js).
  const setup = await context.newPage();
  await setup.goto(extUrl('popup.html'));
  await setup.evaluate(async ({ origin, marketOrigin }) => {
    await chrome.storage.local.set({
      [`settings:${origin}`]: {
        myStores: ['Ron Lewis Chrysler Dodge Jeep Ram Waynesburg', 'Ron Lewis Chrysler Dodge Jeep Ram Cranberry'],
        basis: 'website',
        salesperson: { name: 'Roger', title: 'sales consultant' },
        dealer: { name: 'Ron Lewis Chrysler Dodge Jeep Ram Waynesburg', city: 'Waynesburg', state: 'PA', zip: '15370' },
        priceNote: 'Price includes the $490 doc fee; tax and tags extra.',
        dailyCap: 10,
        rewrite: { enabled: false, endpoint: '', key: '' },
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

  // ---- 1. One scan from the popup on the website, then the website is closed ----
  const dealer = await context.newPage();
  await dealer.goto(siteUrl);
  const popup = watch(await context.newPage());
  await popup.addInitScript((url) => {
    const realQuery = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (q) => (q && q.active ? realQuery({ url }) : realQuery(q));
  }, siteUrl);
  await popup.goto(extUrl('popup.html'));
  await popup.click('#scan');
  await popup.waitForFunction(() => /2 ready to post/.test(document.querySelector('.meta')?.textContent || ''));
  await popup.close();
  await dealer.close();
  assert.equal(context.pages().filter((p) => p.url().startsWith(origin)).length, 0, 'no dealer tab is open from here on');
  const directBefore = Number(await get('/direct-count'));

  // ---- 2. The side panel on its own: the Ready to post list ----
  const panel = watch(await context.newPage());
  await panel.goto(extUrl('sidepanel.html'));
  await panel.waitForSelector('#panelReady');
  const rowNames = async () => panel.$$eval('#panelList .row .name', (els) => els.map((e) => e.textContent.trim()));
  assert.match(await panel.textContent('#panelMeta'), /Last scan .* · 2 ready to post · 10 more posts allowed today/);
  assert.deepEqual((await rowNames()).sort(), ['2019 Ram 1500 Classic Express', '2022 Jeep Wagoneer Series III'].sort());
  assert.match(await panel.textContent('#panelQueue'), /^Post the next 2$/);
  assert.equal(await panel.getAttribute(`button[data-post-vin="${RAM}"]`, 'aria-label'), 'Post 2019 Ram 1500 Classic Express');
  await panel.screenshot({ path: join(shots, 'panel-1-list.png'), fullPage: true });

  // the search box filters as you type, keeps the caret, and Escape clears it
  await panel.click('#panelSearch');
  await panel.keyboard.type('wago');
  await panel.waitForFunction(() => document.querySelectorAll('#panelList .row').length === 1);
  assert.deepEqual(await rowNames(), ['2022 Jeep Wagoneer Series III']);
  assert.equal(await panel.evaluate(() => document.activeElement.id), 'panelSearch');
  assert.equal(await panel.$('#panelQueue'), null, 'one car shown: nothing to queue');
  await panel.keyboard.press('Escape');
  await panel.waitForFunction(() => document.querySelectorAll('#panelList .row').length === 2);
  assert.equal(await panel.inputValue('#panelSearch'), '');

  // the order is the popup's, and choosing one here is remembered for both
  await panel.selectOption('#panelSort', 'name');
  // saving the order, redrawing and putting the focus back on the menu land in
  // turns of their own, and the first row can be the same under the old order:
  // wait for all three rather than read any of them once
  await panel.waitForFunction(
    async (o) =>
      document.activeElement?.id === 'panelSort' &&
      document.querySelector('#panelList .row .name')?.textContent.trim() === '2019 Ram 1500 Classic Express' &&
      (await chrome.storage.local.get(`settings:${o}`))[`settings:${o}`]?.readySort === 'name',
    origin,
  );

  // another website in the registry: the choice appears, and a website with no scan says how to start
  await panel.evaluate(async () => {
    const { sites } = await chrome.storage.local.get('sites');
    await chrome.storage.local.set({ sites: { ...sites, 'https://www.other-motors.test': { name: 'Other Motors' } } });
  });
  await panel.waitForSelector('#panelSite');
  await panel.selectOption('#panelSite', 'https://www.other-motors.test');
  await panel.waitForFunction(() => /click <b>Scan website<\/b>|click Scan website/.test(document.getElementById('panel').innerText) && !document.getElementById('panelReady'));
  assert.equal(await panel.textContent('#site'), 'Other Motors');
  await panel.selectOption('#panelSite', origin);
  await panel.waitForSelector('#panelReady');
  await panel.evaluate(async () => {
    const { sites } = await chrome.storage.local.get('sites');
    delete sites['https://www.other-motors.test'];
    await chrome.storage.local.set({ sites });
  });
  await panel.waitForFunction(() => !document.getElementById('panelSite'));

  // ---- 3. The Ram sold since the scan: Post re-checks it on the website, with no tab, and stops ----
  // Set-up was never run here, so the posting rules come first: nothing is
  // read or begun until they are ticked, and the tick goes on with the same car.
  await get('/scenario?name=day2');
  await panel.click(`button[data-post-vin="${RAM}"]`);
  await panel.waitForSelector('#postingRules');
  assert.match(await panel.textContent('#postingRules'), /Pre-owned cars only\./);
  assert.equal(await panel.isDisabled('#rulesContinue'), true, 'nothing goes on before the tick');
  assert.equal(Number(await get('/direct-count')), directBefore, 'the car is not read before the tick');
  await panel.check('#rulesRead');
  assert.equal(await panel.isDisabled('#rulesContinue'), false);
  await panel.click('#rulesContinue');
  await panel.waitForSelector('#blocked', { timeout: 20000 });
  assert.ok(await panel.evaluate(async (o) => Boolean((await chrome.storage.local.get(`settings:${o}`))[`settings:${o}`].rulesReadAt), origin), 'the tick is saved for this website');
  assert.match(await panel.textContent('#blocked'), /isn't on the website any more/);
  assert.ok(Number(await get('/direct-count')) > directBefore, 'the car was read from the extension, straight from the inventory service');
  await panel.screenshot({ path: join(shots, 'panel-2-sold.png') });
  await panel.click('#back');
  await panel.waitForSelector('#panelReady');

  // ---- 4. The Wagoneer's price dropped: posted at the website's price now, not the scan's ----
  // (first started and stopped at review: Stop this post goes back to the list, nothing opened)
  // The list's own hint says so: a changed price is posted as the website shows it, not stopped.
  const listHint = await panel.textContent('#panelListHint');
  assert.match(listHint, /a price that changed since the last scan is posted as the website shows it now/, 'the list says a new price is posted, not stopped');
  assert.doesNotMatch(listHint, /changed since the last scan is stopped/, 'the list no longer says every changed car is stopped');
  await panel.click(`button[data-post-vin="${WAGONEER}"]`);
  await panel.waitForSelector('#stopPost', { timeout: 20000 });
  const tabsBeforeStop = context.pages().length;
  await panel.click('#stopPost');
  await panel.waitForSelector('#panelReady');
  assert.match(await panel.textContent('#status'), /Stopped the post of 2022 Jeep Wagoneer Series III\./);
  assert.equal(await panel.evaluate(async (o) => (await chrome.storage.local.get(`postFlow:${o}`))[`postFlow:${o}`] ?? null, origin), null, 'the stopped post is not saved');
  assert.equal(context.pages().length, tabsBeforeStop, 'no Facebook tab opened');
  await panel.click(`button[data-post-vin="${WAGONEER}"]`);
  await panel.waitForSelector('#openForm', { timeout: 20000 });
  assert.match(await panel.textContent('#vehicle'), /2022 Jeep Wagoneer Series III/);
  assert.match(await panel.textContent('#vehicle'), /Posting at \$36,883/, 'the website\'s price at post time');
  assert.match(await panel.textContent('#checks'), /All checks passed/);
  await panel.screenshot({ path: join(shots, 'panel-3-review.png'), fullPage: true });
  const [fb] = await Promise.all([context.waitForEvent('page'), panel.click('#openForm')]);
  watch(fb);
  await panel.waitForSelector('#confirmPosted', { timeout: 30000 });
  await panel.waitForSelector('#photos.done', { timeout: 60000 });
  assert.equal(await fb.inputValue('#vin'), WAGONEER);
  assert.equal(await fb.inputValue('#price'), '36,883');
  assert.equal(await publishCount(), '0', 'the extension must not publish');
  await fb.click('#publish'); // the salesperson's own click
  // The mock lands every Publish on 424242, the Ram's listing, as a
  // notification clicked on the form would: the single post reads the page
  // too, and another car's listing is never offered as this car's link.
  await panel.waitForFunction(() => /couldn't confirm that it shows 2022 Jeep Wagoneer Series III/.test(document.querySelector('#detected')?.textContent || ''), null, { timeout: 20000 });
  assert.match(await panel.textContent('#detected'), /so its address isn't offered as this car's link/);
  assert.equal(await panel.inputValue('#listingUrl'), '', "the Ram's listing is not in the Wagoneer's Listing link box");
  await panel.click('#confirmPosted');
  await panel.waitForSelector('#done');
  assert.match(await panel.textContent('#done'), /Recorded: 2022 Jeep Wagoneer Series III at \$36,883/);
  assert.equal(await panel.$('#done + p a'), null, 'recorded with no listing link');
  assert.equal(await publishCount(), '1');
  await fb.close();

  // ---- 5. Post another car: back to the list, which still shows the last scan ----
  await panel.click('#postAnother');
  await panel.waitForSelector('#panelReady');
  assert.deepEqual(await rowNames(), ['2019 Ram 1500 Classic Express'], 'the posted Wagoneer is off the list');
  assert.match(await panel.textContent('#panelMeta'), /1 ready to post · 9 more posts allowed today/);

  // ---- 6. Rescan the website from the panel: the sale, the new arrival and the car that became ready ----
  await panel.click('#panelRescan');
  await panel.waitForFunction(() => /Rescanned 127\.0\.0\.1:\d+: \d+ used cars?\./.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  await panel.waitForFunction(() => document.querySelectorAll('#panelList .row').length === 2);
  assert.deepEqual((await rowNames()).sort(), ['2016 Dodge Challenger SRT Hellcat', '2021 Chevrolet Silverado 1500 LTZ'].sort());
  assert.match(await panel.textContent('#panelMeta'), /2 ready to post · 9 more posts allowed today/);
  const sites = await panel.evaluate(async () => (await chrome.storage.local.get('sites')).sites);
  assert.equal(sites[origin].lastReason, 'panel');
  assert.equal(sites[origin].lastError, null);
  await panel.screenshot({ path: join(shots, 'panel-4-rescanned.png'), fullPage: true });

  // ---- 7. "Post the next 2": a queue walked in the panel, with no dealer tab; a car posted meanwhile is skipped ----
  await panel.click('#panelQueue');
  await panel.waitForSelector('#queueBar');
  assert.match(await panel.textContent('#queueBar'), /Car 1 of 2/);
  const stored = await panel.evaluate(async (o) => (await chrome.storage.local.get(`postQueue:${o}`))[`postQueue:${o}`], origin);
  assert.deepEqual([...stored.vins].sort(), [HELLCAT, SILVERADO].sort());
  assert.equal(stored.dealerTabId, null);
  await panel.waitForSelector('#openForm, #confirmPosted, #blocked', { timeout: 30000 });
  assert.equal(await panel.$('#blocked'), null, 'the first queued car was read from the website, not stopped');
  if (!(await panel.$('#confirmPosted'))) await panel.click('#openForm'); // a car with something assumed waits at review for this click
  await panel.waitForSelector('#confirmPosted', { timeout: 30000 });
  // meanwhile a colleague posts the second car (their entry arrives through
  // the sync): the queue must skip it, never open a second form for it
  const [first, second] = stored.vins;
  await panel.evaluate(async ({ o, vin }) => {
    const k = `posted:${o}`;
    const data = await chrome.storage.local.get(k);
    await chrome.storage.local.set({ [k]: { ...data[k], [vin]: { name: 'posted by a colleague', price: 1, postedAt: new Date().toISOString(), mine: false } } });
  }, { o: origin, vin: second });
  const formsBefore = context.pages().filter((p) => p.url().startsWith(marketOrigin)).length;
  await panel.click('#skipCar'); // the salesperson skips the first car
  await panel.waitForSelector('#queueDone', { timeout: 20000 });
  assert.match(await panel.textContent('#queueBar'), /Queue finished: 2 cars · 2 skipped/);
  assert.match(await panel.textContent('#status'), /is already marked as posted, so the queue skipped it\./);
  assert.equal(context.pages().filter((p) => p.url().startsWith(marketOrigin)).length, formsBefore, 'no form was opened for the car already posted');
  await panel.click('#queueClear');
  await panel.waitForSelector('#panelReady');
  assert.equal(await panel.evaluate(async (o) => (await chrome.storage.local.get(`postQueue:${o}`))[`postQueue:${o}`] ?? null, origin), null);
  assert.deepEqual(await panel.$$eval('#panelList .row [data-post-vin]', (els) => els.map((e) => e.dataset.postVin)), [first], 'the colleague\'s car is off the list');
  assert.equal(await publishCount(), '1', 'nothing was published but the salesperson\'s own click');
  for (const p of context.pages()) if (p.url().startsWith(marketOrigin)) await p.close();

  // ---- 8. A copy of another window's post, changed there since: the save refused here is said, the typed text kept ----
  // A second Chrome window stands in for the first window's side panel. Its
  // post of the car is written into storage as that window's, and the panel
  // here is reloaded, so it brings that post back as a side panel opened in a
  // second window does. A photo unticked here while the copy is the post as
  // it stands is saved; then the other window opens the car's form (its
  // newer post, without that pick, written over the copy's), and text typed
  // here can't be saved: the panel says so, keeps the text to copy, names
  // the photo pick, writes nothing over the other window's post and opens no form.
  const flowKey = `postFlow:${origin}`;
  const savedFlow = () => panel.evaluate(async (k) => (await chrome.storage.local.get(k))[k] ?? null, flowKey);
  const setFlow = (v) => panel.evaluate(async ({ k, v }) => chrome.storage.local.set({ [k]: v }), { k: flowKey, v });
  const otherWindow = await panel.evaluate(async () => {
    const w = await chrome.windows.create({ url: 'about:blank', focused: false });
    return { windowId: w.id, tabId: w.tabs[0].id };
  });
  await panel.click(`button[data-post-vin="${first}"]`);
  await panel.waitForSelector('#openForm', { timeout: 20000 });
  // the review's own save is waited for, so no save of this panel lands after
  // the other window's post is written (it would take that post over, since
  // the other window has no side panel open)
  await panel.waitForFunction(async ({ k, vin }) => {
    const f = (await chrome.storage.local.get(k))[k] || {};
    return f.vin === vin && f.step === 'review' && Boolean(f.description);
  }, { k: flowKey, vin: first }, { timeout: 20000 });
  for (let last = null, i = 0; i < 20; i++) { // and any save after it: the post is left alone for a second
    const now = (await savedFlow()).saveId;
    if (now === last) break;
    last = now;
    await panel.waitForTimeout(1000);
  }
  const theirs = { ...(await savedFlow()), windowId: otherWindow.windowId };
  assert.equal(theirs.vin, first);
  await setFlow(theirs);
  await panel.reload();
  await panel.waitForSelector('#description', { timeout: 20000 });
  assert.equal((await savedFlow()).windowId, otherWindow.windowId, 'the panel here brought back the other window\'s post');
  await panel.click('#photo-0');
  // the pick itself is waited for: the panel may save once on its own when it
  // brings the post back, which renews the save mark before the pick is saved
  await panel.waitForFunction(async (k) => {
    const f = (await chrome.storage.local.get(k))[k] || {};
    return Array.isArray(f.photoPick);
  }, flowKey, { timeout: 10000 }).catch(() => {});
  const picked = await savedFlow();
  assert.notEqual(picked.photoPick, null, 'the pick made here saved while the copy was the post as it stood');
  assert.notEqual(picked.saveId, theirs.saveId, 'saved as a new save of the post');
  const newer = { ...theirs, step: 'publish', fbTabId: otherWindow.tabId, saveId: 'saved-in-the-other-window' };
  await setFlow(newer);
  const typed = 'Typed in this window, with my own closing line: ask for me by name.';
  await panel.fill('#description', typed);
  await panel.waitForSelector('#notSaved', { timeout: 10000 });
  assert.match(await panel.textContent('#notSaved'), /'s Marketplace form is open from the side panel in another Chrome window, and the post changed there after this side panel showed it, so what was done here was not saved\. Finish the post there; opening the side panel in that window brings it back\./);
  assert.equal(await panel.getAttribute('#notSaved', 'role'), 'alert');
  assert.equal(await panel.inputValue('#kept-description'), typed, 'the text typed here is kept on screen');
  assert.equal(await panel.evaluate(() => document.activeElement && document.activeElement.id), 'kept-description', 'the keyboard lands on the kept text, where the typing box was');
  assert.equal(await panel.getAttribute('#kept-description', 'readonly'), '', 'read-only');
  assert.equal(await panel.getAttribute('button[aria-label="Copy the description"]', 'data-copy'), typed, 'Copy copies it');
  assert.equal(await panel.textContent('#notSavedKept'), 'The text from this side panel is below, kept on this screen only: copy it before you leave this screen.');
  assert.equal(await panel.textContent('#notSavedEither'), 'Not saved either, so do it again in that window if you still want it: the photos picked.');
  assert.equal(await panel.$('#openForm'), null, 'the copy is left: no form button');
  assert.deepEqual(await savedFlow(), newer, 'the other window\'s post is not written over');
  assert.equal(context.pages().filter((p) => p.url().startsWith(marketOrigin)).length, 0, 'no form opened');
  await panel.screenshot({ path: join(shots, 'panel-4b-not-saved.png'), fullPage: true });
  // the other window closes with the car's form at Publish (it may have
  // posted from there); Back to the list here leaves that post, which this
  // panel never held, and a side panel opened next brings it back and asks
  // whether it posted: here it didn't, and the post is stopped
  await panel.evaluate(async (id) => chrome.windows.remove(id), otherWindow.windowId);
  await panel.click('#back');
  await panel.waitForSelector('#panelReady');
  assert.deepEqual(await savedFlow(), newer, 'Back to the list here leaves the other window\'s post');
  await panel.reload();
  await panel.waitForSelector('#notPosted', { timeout: 20000 });
  assert.match(await panel.textContent('#detected'), /The Facebook tab was closed\. Did it post\?/);
  await panel.click('#notPosted');
  await panel.waitForSelector('#stopPost');
  await panel.click('#stopPost');
  await panel.waitForSelector('#panelReady');
  assert.equal(await savedFlow(), null, 'stopped');

  // ---- 9. At the daily cap the list keeps its cars and loses its Post buttons ----
  await panel.evaluate(async (o) => {
    const k = `settings:${o}`;
    const data = await chrome.storage.local.get(k);
    await chrome.storage.local.set({ [k]: { ...data[k], dailyCap: 1 } });
  }, origin);
  await panel.waitForSelector('#capReached');
  assert.equal(await panel.locator('button[data-post-vin]').count(), 0);
  assert.equal(await panel.$('#panelQueue'), null);
  assert.equal(await panel.locator('#panelList .row').count(), 1);
  assert.match(await panel.textContent('#capReached'), /Daily post cap reached \(1 of 1 today\)/, 'a colleague\'s post does not count against this salesperson\'s cap');
  await panel.screenshot({ path: join(shots, 'panel-5-cap.png'), fullPage: true });

  // ---- 10. The pilot numbers: three attempts from the panel, one blocked as gone, one stopped at review, one posted ----
  const pilot = await panel.evaluate(async (o) => (await chrome.storage.local.get(`pilot:${o}`))[`pilot:${o}`], origin);
  const outcome = (vin) => pilot.posts.filter((p) => p.vin === vin).map((p) => [p.outcome, p.reason || '']);
  assert.deepEqual(outcome(RAM), [['blocked', 'not-on-website']]);
  assert.deepEqual(outcome(WAGONEER), [['abandoned', ''], ['posted', '']]);

  assert.equal(await publishCount(), '1', 'still only the person\'s one click, and no listing marked sold, deleted or edited since');
  assert.deepEqual(errors, [], 'no console errors');
  facebook.assertNone();
  console.log('Panel E2E passed. Screenshots in test/e2e/screenshots/');
} finally {
  await context.close();
  for (const d of [profileDir, extDir]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { /* see post.e2e.mjs */ } }
  site.close();
  market.close();
}
