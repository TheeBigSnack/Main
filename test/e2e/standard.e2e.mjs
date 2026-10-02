// End-to-end test of a dealership website that publishes standard vehicle
// data (schema.org markup on each car's own page, test/e2e/mock-standard-site.mjs)
// instead of an inventory search service: the popup scans the used-inventory
// list (three pages linked by rel=next; JSON-LD, @graph, microdata-only and
// carousel car pages) -> Ready to post and Needs a look hold the right cars,
// the car whose markup price the page doesn't show has no price, the
// trade-in trailer and the new car in a carousel are never offered as cars
// -> Post fills the mock Marketplace form from the car's own page and the
// test clicks Publish as the salesperson would -> the website sells one
// posted car and drops the other's price while its server is having a bad
// day: the service worker's rescan marks nothing gone, and a car whose page
// failed keeps its last reading -> the server recovers: the next rescan
// checks the sold car at its last page and puts it on To do ->
// a sold car's page that redirects to the list, or says the car is no
// longer available, counts as gone too.
//
// The real facebook.com is never automated. Run: node test/e2e/standard.e2e.mjs
// (npm run test:e2e runs every flow)

import { chromium } from 'playwright';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startMockStandardSite, STANDARD } from './mock-standard-site.mjs';
import { startMockMarketplace } from './mock-marketplace.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const shots = join(root, 'test/e2e/screenshots');
mkdirSync(shots, { recursive: true });

// Test copy of the extension: it may script the two local mock servers and
// nothing else (the real facebook.com and image host permissions are removed).
const extDir = mkdtempSync(join(tmpdir(), 'lot-sync-ext-')); // a fresh folder, so flows can run side by side
cpSync(join(root, 'extension'), extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
// No real side panel in tests: the test opens sidepanel.html as a tab and
// must be the only instance driving the flow.
manifest.permissions = manifest.permissions.filter((p) => p !== 'sidePanel');
delete manifest.side_panel;
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const site = await startMockStandardSite();
const market = await startMockMarketplace();
const origin = `http://127.0.0.1:${site.address().port}`;
const siteUrl = `${origin}/used-vehicles/`;
const marketOrigin = `http://127.0.0.1:${market.address().port}`;
// See popup.e2e.mjs about LOTSYNC_E2E_CHANNEL.
const profileDir = mkdtempSync(join(tmpdir(), 'lot-sync-profile-standard-'));
const context = await chromium.launchPersistentContext(profileDir, {
  channel: process.env.LOTSYNC_E2E_CHANNEL || 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  viewport: { width: 760, height: 900 },
});

const V = STANDARD.VINS;
const DEALER = STANDARD.DEALER.name;
const pathOf = (key) => STANDARD.vehicleRoute(STANDARD.CARS.find((c) => c.key === key));
const errors = [];
let panelRef = null;
let popupRef = null;
const watch = (p) => {
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  p.on('pageerror', (e) => errors.push(String(e)));
  return p;
};
const control = async (path) => (await fetch(origin + path)).text();
const requests = async () => JSON.parse(await control('/requests'));
// How many times Publish was clicked; and first, that nothing ever touched the
// mock form's decoy action controls or submitted it (see mock-marketplace.mjs).
const publishCount = async () => {
  assert.deepEqual(await (await fetch(`${marketOrigin}/actions`)).json(), [], 'nothing may touch an action control but the person');
  return (await fetch(`${marketOrigin}/publish-count`)).text();
};

try {
  const ext = await context.newPage();
  await ext.goto('chrome://extensions');
  const extensionId = await ext.evaluate(async () => (await chrome.management.getAll()).find((e) => e.name === 'Lot Current').id);
  await ext.close();
  const extUrl = (file) => `chrome-extension://${extensionId}/${file}`;

  // Settings and the test hooks go straight into storage, as in post.e2e.mjs.
  // No ZIP: the scan fills it from the website's own structured data.
  const setup = await context.newPage();
  await setup.goto(extUrl('sidepanel.html'));
  await setup.evaluate(async ({ origin, marketOrigin, DEALER }) => {
    await chrome.storage.local.set({
      [`settings:${origin}`]: {
        myStores: [DEALER],
        basis: 'website',
        salesperson: { name: 'Alex', title: 'sales consultant' },
        dealer: { name: DEALER, city: 'Springfield', state: 'OH', zip: '' },
        priceNote: 'Tax, title and registration are extra.',
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
  }, { origin, marketOrigin, DEALER });
  await setup.close();

  const dealer = await context.newPage();
  await dealer.goto(siteUrl);

  async function openPopup() {
    const popup = watch(await context.newPage());
    popupRef = popup;
    // In a real browser the popup sits on top of the dealer tab; here it has
    // its own tab, so point "the active tab" at the dealer page.
    await popup.addInitScript((url) => {
      const realQuery = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (q) => (q && q.active ? realQuery({ url }) : realQuery(q));
    }, siteUrl);
    await popup.goto(extUrl('popup.html'));
    await popup.setViewportSize({ width: 720, height: 590 });
    return popup;
  }
  const tab = (p, name) => p.locator(`.tabs button[data-view="${name}"]`);
  const stored = (p, key) => p.evaluate(async (k) => (await chrome.storage.local.get(k))[k], `${key}:${origin}`);
  const rescanNow = (p) => p.evaluate((o) => chrome.runtime.sendMessage({ type: 'rescanNow', origin: o, reason: 'test' }), origin);
  const vinsOf = (items) => (items || []).map((i) => i.vin);

  // ---- 1. Scan: the list's three pages, each car's own page ----
  await control('/requests?clear=1');
  let popup = await openPopup();
  await popup.click('#scan');
  await popup.waitForSelector('.banner.info', { timeout: 60000 });
  const asked = await requests();
  for (const page of ['/used-vehicles/?page=2', '/used-vehicles/?page=3']) assert.ok(asked.some((r) => r.path === page && r.status === 200), `the list's rel=next page ${page} was read`);
  // no detection evasion: every page is asked for as the browser itself asks
  const browserUa = await dealer.evaluate(() => navigator.userAgent);
  assert.deepEqual([...new Set(asked.map((r) => r.ua))], [browserUa], "the scan sends the browser's own user agent");

  const snap = await stored(popup, 'snapshot');
  const car = (key) => snap.vehicles[V[key]];
  const decision = (key) => car(key) && car(key).decision;
  for (const key of ['civic', 'f150', 'escape', 'accord', 'sorento', 'rav4']) assert.equal(decision(key), 'ready', `${key} is ready to post`);
  // honest prices: the markup says $14,995, the page shows $15,495, so there is no price to post
  assert.equal(decision('malibu'), 'not-ready');
  assert.equal(car('malibu').price, null, 'a price the page does not show is no price');
  assert.ok(car('malibu').blockers.includes('no-price'));
  assert.equal(decision('wrangler'), 'not-ready');
  assert.ok(car('wrangler').blockers.includes('no-photos'));
  assert.equal(decision('outback'), 'review', '12 miles on a used car');
  // the trade-in trailer: held for a person to look at, never offered as a car (Lot Current fills in only the car/truck and motorcycle forms)
  assert.equal(decision('trailer'), 'review', 'the trailer waits on Needs a look');
  assert.match(car('trailer').reason, /makes it a trailer/);
  // the new car in the Sorento's carousel is not part of the used lot, and nothing else crept in
  assert.equal(car('telluride'), undefined, 'the carousel\'s new car is not read as a car on the lot');
  const onLot = new Set(STANDARD.lot('day1').map((c) => c.vin));
  assert.deepEqual(Object.keys(snap.vehicles).filter((vin) => !onLot.has(vin)), [], 'only cars from the used list');
  // each car read from its own page: the carousel's cars, the @graph and the microdata-only page
  assert.deepEqual([car('sorento').price, car('sorento').mileage, car('sorento').photoCount], [25995, 35780, 3], "the Sorento's own page, not its carousel");
  assert.deepEqual([car('escape').price, car('escape').mileage, car('escape').photoCount], [16495, 52110, 3], 'the microdata-only page');
  assert.deepEqual([car('f150').price, car('f150').mileage, car('f150').photoCount], [31495, 58112, 3], 'the @graph page');

  assert.match(await popup.textContent('.meta'), new RegExp(`${Object.keys(snap.vehicles).length} used cars · 6 ready to post`));
  assert.equal(await tab(popup, 'ready').locator('.count').textContent(), '6');
  assert.equal(await tab(popup, 'notReady').locator('.count').textContent(), '2');
  assert.equal(await tab(popup, 'review').locator('.count').textContent(), '2');
  assert.equal(await tab(popup, 'otherStores').count(), 0, 'one store, so no Other stores tab');
  await tab(popup, 'ready').click();
  const ready = await popup.textContent('.rows');
  for (const name of ['2018 Ford Escape SE', '2019 Ford F-150 XLT', '2019 Honda Civic EX', '2020 Honda Accord Sport', '2021 Kia Sorento LX', '2022 Toyota RAV4 XLE']) assert.ok(ready.includes(name), `${name} on Ready to post`);
  assert.doesNotMatch(ready, /Malibu|Trailer|Telluride|Outback/);
  await popup.screenshot({ path: join(shots, 'standard-1-ready.png') });
  await tab(popup, 'notReady').click();
  const notReady = await popup.textContent('.panel');
  assert.match(notReady, /2017 Chevrolet Malibu LT[\s\S]*No price on the website/);
  assert.match(notReady, /2016 Jeep Wrangler Sport[\s\S]*No photos on the website yet/);
  assert.doesNotMatch(notReady, /14,995/, 'the markup price is never shown as the price');
  assert.equal(await popup.locator('button[data-action="openPost"]').count(), 0, 'nothing on Not ready can be posted');
  await tab(popup, 'review').click();
  assert.match(await popup.textContent('.panel'), /2025 Subaru Outback Premium[\s\S]*12 miles/);
  await popup.screenshot({ path: join(shots, 'standard-2-needs-a-look.png') });

  // ---- 2. Post the Civic: the side panel re-reads its page, the form is filled, the person publishes ----
  await tab(popup, 'ready').click();
  await popup.click(`button[data-action="openPost"][data-vin="${V.civic}"]`);
  await popup.waitForFunction(() => /side panel/i.test(document.querySelector('#status').textContent));
  await popup.close();
  const panel = watch(await context.newPage());
  panelRef = panel;
  await panel.goto(extUrl('sidepanel.html'));
  await panel.waitForSelector('#openForm', { timeout: 30000 });
  const vehicle = await panel.textContent('#vehicle');
  assert.match(vehicle, /2019 Honda Civic EX/);
  assert.match(vehicle, /\$19,995/);
  const draft = await panel.inputValue('#description');
  assert.match(draft, /^2019 Honda Civic EX with 41,230 miles\./);
  assert.match(draft, /This Civic EX has the 1\.5L Turbo 4-Cylinder, a CVT and a sunroof\./, "the car's own write-up is kept");
  assert.doesNotMatch(draft, /one owner/i, 'no Carfax one-owner flag in standard data, so never said');
  assert.match(draft, /Tax, title and registration are extra\./);
  assert.match(draft, new RegExp(`I'm Alex, sales consultant at ${DEALER}\\.`));
  assert.match(draft, new RegExp(`VIN ${V.civic}\\.`));
  assert.match(await panel.textContent('#checks'), /All checks passed/);
  assert.match(await panel.textContent('#vinCheck'), /2019, website agrees[\s\S]*Honda/);
  assert.match(await panel.textContent('#panel'), /Location[\s\S]*45505/, "the ZIP from the website's structured data");
  await panel.screenshot({ path: join(shots, 'standard-3-review.png'), fullPage: true });

  const [fb] = await Promise.all([context.waitForEvent('page'), panel.click('#openForm')]);
  watch(fb);
  await panel.waitForSelector('#confirmPosted', { timeout: 60000 });
  await panel.waitForSelector('#photos.done', { timeout: 30000 });
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
    vehicleType: 'Car/Truck', year: '2019', make: 'Honda', model: 'Civic EX', vin: V.civic, mileage: '41230',
    price: '19,995', // the website's shown price; the page reformats it
    bodyStyle: 'Sedan', exteriorColor: 'Silver', interiorColor: 'Grey', fuelType: 'Gasoline', transmission: 'Automatic transmission',
    location: '', // the mock form suggests only another state's town for this ZIP: nothing is picked, the person picks
    condition: 'Very good', titleStatus: 'Clean',
    cleanTitle: true,
    photos: '3 photos', // same-origin photos, downloaded by the service worker
    popupsOpen: 0,
  });
  const results = await panel.textContent('#fillResults');
  assert.match(results, /Filled in\s*16/);
  assert.match(await panel.textContent('#panel'), /Couldn't fill\s*1[\s\S]*Location/);
  assert.match(await panel.textContent('#photos'), /3 of 3 attached/);
  assert.equal(await publishCount(), '0', 'the extension must not publish');
  await fb.screenshot({ path: join(shots, 'standard-4-mock-form.png'), fullPage: true });

  await fb.click('#publish'); // the person
  await panel.waitForSelector('#detected', { timeout: 15000 });
  await panel.click('#confirmPosted');
  await panel.waitForSelector('#done');
  assert.match(await panel.textContent('#done'), /Recorded: 2019 Honda Civic EX at \$19,995/);
  assert.equal(await publishCount(), '1');
  await panel.close();
  panelRef = null;

  // The Accord was listed by hand: Mark posted, so rescans watch it too.
  popup = await openPopup();
  await tab(popup, 'ready').click();
  await popup.click(`button[data-action="post"][data-vin="${V.accord}"]`);
  await popup.waitForSelector(`button[data-action="unpost"][data-vin="${V.accord}"]`);
  assert.equal(await tab(popup, 'mine').locator('.count').textContent(), '2');

  // ---- 3. Day 2 on a bad server day: the Accord sold, but its old page answers 429 and another car's page 500 ----
  await control('/scenario?name=day2');
  await control('/flaky?on=1');
  await control('/requests?clear=1');
  const bad = await rescanNow(popup);
  const badAsked = await requests();
  assert.ok(badAsked.some((r) => r.status === 429 || r.status === 500), 'the server did fail some requests');
  assert.equal(badAsked.filter((r) => r.path === pathOf('accord')).length, 1, 'a page that answered 429 is not asked for again');
  assert.deepEqual([...new Set(badAsked.map((r) => r.ua))], [browserUa], "the service worker sends the browser's own user agent too");
  assert.equal(bad.ok, true, `the rest of the lot was read (rescan: ${JSON.stringify(bad)})`);
  const afterBad = await stored(popup, 'diff');
  assert.deepEqual(vinsOf(afterBad.takeDown), [], 'nothing is marked gone while the server fails');
  assert.deepEqual(vinsOf(afterBad.needsALook), [V.accord], 'the missing Accord waits for a later rescan, and nothing else is flagged');
  assert.match(afterBad.warnings.join(' '), /Couldn't double-check missing cars \(The website asked Lot Current to slow down \(HTTP 429\)\)\. Nothing was marked as gone\./);
  // the Sorento's page answered 500: it keeps what its page said last time, not the list's thinner data
  assert.match(afterBad.warnings[0], /One car's page could not be read this time/);
  const sorentoBad = (await stored(popup, 'snapshot')).vehicles[V.sorento];
  assert.deepEqual([sorentoBad.decision, sorentoBad.price, sorentoBad.mileage], ['ready', 25995, 35780], 'a page that failed changes nothing about its car');
  // what the rest of the lot said that day is on To do already
  assert.deepEqual(afterBad.priceUpdates.map((p) => [p.vin, p.from, p.to]), [[V.civic, 19995, 18995]]);
  assert.deepEqual(vinsOf(afterBad.newArrivals), [V.tucson]);
  assert.deepEqual(vinsOf(afterBad.nowReady), [V.wrangler]);
  await popup.close();
  popup = await openPopup();
  const badTodo = await popup.textContent('.panel');
  assert.match(badTodo, /New arrivals\s*1[\s\S]*2021 Hyundai Tucson SEL/);
  assert.match(badTodo, /Just became ready\s*1[\s\S]*2016 Jeep Wrangler Sport/);
  assert.doesNotMatch(badTodo, /Gone from the website/);
  await control('/flaky?on=0');

  // ---- 4. The server recovers: the next rescan confirms the sale at the Accord's last page ----
  // (the Accord left the list on the bad day; the snapshot kept its page address)
  await control('/requests?clear=1');
  const good = await rescanNow(popup);
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.ok((await requests()).some((r) => r.path === pathOf('accord') && r.status === 404), "the sold car's page answered 404");
  const day2 = await stored(popup, 'diff');
  assert.deepEqual(day2.takeDown.map((t) => [t.vin, t.why]), [[V.accord, 'gone']]);
  assert.deepEqual(day2.priceUpdates.map((p) => [p.vin, p.from, p.to]), [[V.civic, 19995, 18995]], 'the posted Civic still shows its old price on Marketplace');
  assert.deepEqual(day2.needsALook, []);
  assert.equal(await popup.evaluate(() => chrome.action.getBadgeText({})), '2');
  await popup.close();
  popup = await openPopup();
  const todo = await popup.textContent('.panel');
  assert.match(todo, /Take down\s*1[\s\S]*2020 Honda Accord Sport[\s\S]*Gone from the website/);
  assert.match(todo, /Update price\s*1[\s\S]*2019 Honda Civic EX[\s\S]*\$19,995 → \$18,995/);
  assert.equal(await tab(popup, 'todo').locator('.count').textContent(), '2');
  await popup.screenshot({ path: join(shots, 'standard-5-day2-todo.png'), fullPage: true });

  // ---- 5. Other ways a website retires a sold car's page: a 301 to the list, a "no longer available" page ----
  for (const [soldPage, status] of [['301', 301], ['200', 200]]) {
    await control('/scenario?name=day1'); // the Accord back in the last scan, with its page address
    assert.equal((await rescanNow(popup)).ok, true);
    await control(`/scenario?name=day2&soldPage=${soldPage}`);
    await control('/requests?clear=1');
    const r = await rescanNow(popup);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok((await requests()).some((q) => q.path === pathOf('accord') && q.status === status), `the sold car's page answered ${status}`);
    assert.deepEqual((await stored(popup, 'diff')).takeDown.map((t) => [t.vin, t.why]), [[V.accord, 'gone']], `a sold car whose page answers ${status} is gone`);
  }
  await popup.close();

  assert.equal(await publishCount(), '1', "still only the person's one click");
  assert.deepEqual(errors, [], 'no console errors');
  console.log('Standard data E2E passed. Screenshots in test/e2e/screenshots/');
} catch (e) {
  for (const [name, p] of [['Panel', panelRef], ['Popup', popupRef]]) {
    if (p && !p.isClosed()) {
      console.error(`${name} text:`, (await p.textContent('body').catch(() => '')).replace(/\s+/g, ' ').slice(0, 800));
      await p.screenshot({ path: join(shots, `standard-failure-${name.toLowerCase()}.png`), fullPage: true }).catch(() => {});
    }
  }
  console.error('Requests to the mock site:', JSON.stringify(await requests().catch(() => [])).slice(0, 3000));
  console.error('Console errors:', errors);
  throw e;
} finally {
  await context.close();
  // leave nothing behind: the throwaway profile and the extension copy
  for (const d of [profileDir, extDir]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { /* still locked by the closing browser; every run makes its own folders, so a leftover does no harm */ } }
  site.close();
  market.close();
}
