// End-to-end test of the first-run wizard and the background rescan: a fresh
// profile with no settings -> the popup offers set-up -> the side panel walks
// the steps (read the website, store, name, address from the site's own
// structured data, the price to post, permission for automatic rescans, the
// posting rules, the Terms of Service and Privacy Policy; the Account step
// after the name too when src/accountConfig.js is filled in, skipped here) ->
// Ready to post is right -> the salesperson marks a car posted -> the mock
// site "sells" it -> the service worker rescans it by calling the inventory
// service directly (no tab) -> the badge shows 1 and the popup's To do agrees.
//
// The real facebook.com is never automated. Run: npm run test:e2e:wizard

import { chromium } from 'playwright';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startMockSite } from './mock-dealer-site.mjs';
import { LEGAL, legalHosted } from '../../extension/src/legalLinks.js';
import { wizardSteps } from '../../extension/src/wizardSteps.js';
import { accountsConfigured } from '../../extension/src/accountConfig.js';
import { blockFacebook } from './noFacebook.mjs';

// The step numbers come from the wizard's own list, so filling in the
// account config (supabase/README.md step 6) adds the Account step here too.
const STEPS = wizardSteps(accountsConfigured());
if (!accountsConfigured()) assert.equal(STEPS.length, 10, 'the shipped wizard without accounts has ten steps');
const stepOf = (name) => {
  assert.ok(STEPS.includes(name), `no ${name} step`);
  return new RegExp(`step ${STEPS.indexOf(name) + 1} of ${STEPS.length}(?!\\d)`); // the heading follows with no space
};

const root = fileURLToPath(new URL('../..', import.meta.url));
const shots = join(root, 'test/e2e/screenshots');
mkdirSync(shots, { recursive: true });

const extDir = mkdtempSync(join(tmpdir(), 'lot-current-ext-')); // a fresh folder, so flows can run side by side
cpSync(join(root, 'extension'), extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
manifest.permissions = manifest.permissions.filter((p) => p !== 'sidePanel'); // no real side panel in tests
delete manifest.side_panel;
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const site = await startMockSite();
const siteUrl = `http://127.0.0.1:${site.address().port}/used-vehicles/`;
const origin = new URL(siteUrl).origin;
const profileDir = mkdtempSync(join(tmpdir(), 'lot-current-profile-wizard-'));
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

try {
  const ext = await context.newPage();
  await ext.goto('chrome://extensions');
  const extensionId = await ext.evaluate(async () => (await chrome.management.getAll()).find((e) => e.name === 'Lot Current').id);
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
  assert.match(await panel.textContent('#panel'), /Set up Lot Current for this dealership/);
  assert.match(await panel.textContent('#panel'), stepOf('welcome'));
  await panel.click('#wizNext'); // -> read the website (runs by itself)
  await panel.waitForSelector('.banner.good', { timeout: 30000 });
  assert.match(await panel.textContent('.banner.good'), /6 used cars read from Ron Lewis Chrysler Dodge Jeep Ram Waynesburg\. 3 stores found\./);
  await panel.screenshot({ path: join(shots, 'wizard-1-read.png') });
  await panel.click('#wizNext'); // -> store
  const stores = await panel.$$eval('.wizStore', (boxes) => boxes.map((b) => `${b.value}=${b.checked}`));
  assert.deepEqual(stores, ['Ron Lewis Chrysler Dodge Jeep Ram Cranberry=false', 'Ron Lewis Chrysler Dodge Jeep Ram Pleasant Hills=false', 'Ron Lewis Chrysler Dodge Jeep Ram Waynesburg=true'], 'the store matching the site name is pre-ticked');
  await panel.click('#wizNext'); // -> you
  await panel.fill('#wizName', 'Roger');
  assert.match(await panel.textContent('#panel'), stepOf('you'));
  // a number in the role keeps the Marketplace form shut for nearly every car: the step says so as it is typed, and stops once it is gone
  assert.equal(await panel.getAttribute('#wizTitle', 'aria-describedby'), 'wizTitleWarn');
  assert.equal(await panel.getAttribute('#wizTitleWarn', 'aria-live'), null, 'the warning under the field changes on every key, so it is not spoken on each');
  assert.equal(await panel.getAttribute('#wizTitleSay', 'aria-live'), 'polite', 'a screen reader hears the warning from the live region beside it');
  assert.equal((await panel.textContent('#wizTitleWarn')).trim(), '', 'no warning for the default role');
  assert.equal((await panel.textContent('#wizTitleSay')).trim(), '');
  // typed key by key: the warning follows every key, the live region changes once, when the warning comes
  await panel.evaluate(() => {
    window.__sayWrites = 0;
    new MutationObserver((list) => { window.__sayWrites += list.length; }).observe(document.querySelector('#wizTitleSay'), { childList: true, characterData: true, subtree: true });
  });
  await panel.fill('#wizTitle', '');
  await panel.locator('#wizTitle').pressSequentially('2nd shift sales');
  await panel.waitForFunction(() => /"Second shift sales"/.test(document.querySelector('#wizTitleWarn').textContent));
  assert.match(await panel.textContent('#wizTitleWarn'), /^A number in your role \("2nd"\) keeps the Marketplace form shut for nearly every car: every number in a description must match the website's data for the car\. Write the number as a word or leave it out, for example "Second shift sales"\.$/);
  assert.equal((await panel.textContent('#wizTitleSay')).trim(), "A number in your role keeps the Marketplace form shut for nearly every car: every number in a description must match the website's data for the car. Write the number as a word or leave it out.");
  assert.equal(await panel.evaluate(() => window.__sayWrites), 1, 'the live region was written once over 15 keys');
  await panel.fill('#wizTitle', 'sales consultant');
  await panel.waitForFunction(() => document.querySelector('#wizTitleWarn').textContent.trim() === '' && document.querySelector('#wizTitleSay').textContent.trim() === '');
  await panel.click('#wizNext'); // -> account (when configured), then address
  if (STEPS.includes('account')) {
    await panel.waitForSelector('#wizEmail');
    assert.match(await panel.textContent('h3'), /^Your account$/);
    assert.match(await panel.textContent('#panel'), stepOf('account'));
    assert.equal((await panel.textContent('#wizNext')).trim(), 'Skip for now', 'signing in is optional');
    await panel.click('#wizNext'); // -> address, signed out
  }
  await panel.waitForSelector('#wizZip');
  assert.match(await panel.textContent('#panel'), stepOf('address'));
  assert.equal(await panel.inputValue('#wizCity'), 'Waynesburg');
  assert.match(await panel.textContent('#wizAddressHint'), /^Read from the website \(structured data\)\. Marketplace asks/, 'the step says where the address came from');
  assert.equal(await panel.inputValue('#wizState'), 'PA');
  assert.equal(await panel.inputValue('#wizZip'), '15370', "from the website's structured data");
  await panel.click('#wizNext'); // -> price
  await panel.waitForSelector('#wizPriceNote');
  assert.match(await panel.textContent('h3'), /^The price to post$/);
  assert.match(await panel.textContent('#panel'), stepOf('price'));
  // The mock site shows a lower second price on every priced car ($490 below the main one), so the
  // choice is offered with the main price first; on a site with one price per car there is no radio.
  const bases = await panel.$$eval('input[name="wizBasis"]', (rs) => rs.map((r) => `${r.value}=${r.checked}`));
  assert.deepEqual(bases, ['website=true', 'beforeFees=false'], "the website's main price is the default");
  const priceStep = await panel.textContent('#panel');
  assert.match(priceStep, /Some states require the advertised price to include dealer fees\. Check with your manager before choosing this\./);
  assert.match(priceStep, /main price is usually \$490 higher than the lower second price/);
  assert.match(priceStep, /e\.g\. \$27,163 "Ron Lewis Real Price"[\s\S]*e\.g\. \$26,673; usually the price before the doc fee/);
  assert.equal(await panel.inputValue('#wizPriceNote'), '', 'the note is never filled in for the person');
  assert.equal(await panel.getAttribute('#wizPriceNote', 'placeholder'), 'Price includes the $490 doc fee; tax and tags extra.');
  assert.equal(await panel.textContent('#wizPriceHint'), 'Honest prices: the listed price always equals the website price. This note explains what it includes. Suggested: "Price includes the $490 doc fee; tax and tags extra."');
  await panel.check('input[name="wizBasis"][value="beforeFees"]'); // the suggested wording follows the basis
  assert.equal(await panel.getAttribute('#wizPriceNote', 'placeholder'), 'Price is before the $490 doc fee; tax and tags extra.');
  assert.match(await panel.textContent('#wizPriceHint'), /Suggested: "Price is before the \$490 doc fee; tax and tags extra\."$/);
  await panel.fill('#wizPriceNote', 'Tax and tags extra.');
  await panel.click('#wizBack'); // the choice and the typed note survive Back and Next
  await panel.waitForSelector('#wizZip');
  await panel.click('#wizNext');
  await panel.waitForSelector('#wizPriceNote');
  assert.equal(await panel.inputValue('#wizPriceNote'), 'Tax and tags extra.');
  assert.equal(await panel.isChecked('input[name="wizBasis"][value="beforeFees"]'), true);
  assert.equal(await panel.getAttribute('#wizPriceNote', 'placeholder'), 'Price is before the $490 doc fee; tax and tags extra.');
  await panel.screenshot({ path: join(shots, 'wizard-1a-price.png'), fullPage: true });
  await panel.click('#wizNext'); // -> permission
  assert.match(await panel.textContent('#panel'), /Automatic rescans/);
  assert.match(await panel.textContent('#panel'), stepOf('permission'));
  await panel.click('#wizGrant'); // the test copy already has this host; Chrome answers without a prompt
  await panel.waitForSelector('.banner.good');
  assert.match(await panel.textContent('.banner.good'), /Permission granted/);
  await panel.click('#wizNext'); // -> rules
  assert.match(await panel.textContent('ol.rules'), /You publish every post\.[\s\S]*Ads law applies\./);
  assert.match(await panel.textContent('#panel'), stepOf('rules'));
  assert.equal(await panel.isDisabled('#wizNext'), true, 'the rules must be ticked before Next');
  await panel.check('#wizRulesRead');
  assert.equal(await panel.isDisabled('#wizNext'), false);
  await panel.screenshot({ path: join(shots, 'wizard-2-rules.png'), fullPage: true });
  // The Terms step has two faces (legalLinks.js legalHosted): while the documents are placeholders
  // it is informational (nothing to accept, no dead link); once they are hosted it gates Finish on
  // the tick and records the acceptance. Both are covered, whichever the addresses are today.
  const hosted = legalHosted();
  const termsReady = hosted ? '#wizTermsRead' : '#legalPending';
  await panel.click('#wizNext'); // -> terms
  await panel.waitForSelector(termsReady);
  assert.match(await panel.textContent('#panel'), stepOf('terms'));
  assert.match(await panel.textContent('#panel'), /Terms and privacy[\s\S]*never your Facebook login[\s\S]*not affiliated with Meta Platforms, Inc\./);
  if (!hosted) {
    assert.match(await panel.textContent('#legalPending'), /being finalised/);
    assert.match(await panel.textContent('#legalPending'), /accept them in Settings/, 'says where the acceptance will happen');
    assert.equal(await panel.$('#wizTermsRead'), null, 'no acceptance tick while the documents cannot be read');
    assert.equal(await panel.$$eval('#panel a[target="_blank"]', (as) => as.length), 0, 'no dead links');
    assert.equal(await panel.isDisabled('#wizFinish'), false);
  } else {
    const links = await panel.$$eval('#panel a[target="_blank"]', (as) => as.map((a) => [a.textContent, a.href, a.rel]));
    assert.deepEqual(links, [['Terms of Service', LEGAL.termsUrl, 'noopener'], ['Privacy Policy', LEGAL.privacyUrl, 'noopener']]);
    assert.equal(await panel.isDisabled('#wizFinish'), true, 'the Terms must be accepted before Finish');
    await panel.check('#wizTermsRead');
    assert.equal(await panel.isDisabled('#wizFinish'), false);
  }
  await panel.click('#wizBack'); // the ticks survive a step back and forward
  await panel.waitForSelector('#wizRulesRead');
  assert.equal(await panel.isChecked('#wizRulesRead'), true);
  await panel.click('#wizNext');
  await panel.waitForSelector(termsReady);
  if (hosted) {
    assert.equal(await panel.isChecked('#wizTermsRead'), true);
    assert.equal(await panel.isDisabled('#wizFinish'), false);
  }
  await panel.screenshot({ path: join(shots, 'wizard-3-terms.png'), fullPage: true });
  await panel.click('#wizFinish');
  await panel.waitForFunction(() => /Set up\./.test(document.querySelector('.banner.good')?.textContent || ''), null, { timeout: 30000 });
  assert.match(await panel.textContent('.banner.good'), /1 car is ready to post[\s\S]*Automatic rescans are on/);
  await panel.screenshot({ path: join(shots, 'wizard-4-done.png') });

  const saved = await panel.evaluate(async (o) => {
    const all = await chrome.storage.local.get(null);
    const s = all[`settings:${o}`];
    const alarm = await chrome.alarms.get('lot-sync-rescan');
    return { name: s.salesperson.name, stores: s.myStores, zip: s.dealer.zip, basis: s.basis, priceNote: s.priceNote, autoRescan: s.autoRescan, notify: s.notify, rulesRead: Boolean(s.rulesReadAt), legalVersion: s.legal.version, legalAccepted: Boolean(s.legal.acceptedAt), wizardDone: Boolean(all[`wizardDone:${o}`]), siteAuto: all.sites[o].auto, service: all.sites[o].service.search, alarmMinutes: alarm && alarm.periodInMinutes };
  }, origin);
  // the acceptance is recorded only when the documents could be read and the tick was given; the
  // lower price was accepted as the basis because this website shows one, and the note is the typed one
  assert.deepEqual(saved, { name: 'Roger', stores: ['Ron Lewis Chrysler Dodge Jeep Ram Waynesburg'], zip: '15370', basis: 'beforeFees', priceNote: 'Tax and tags extra.', autoRescan: true, notify: true, rulesRead: true, legalVersion: hosted ? LEGAL.version : '', legalAccepted: hosted, wizardDone: true, siteAuto: true, service: `${origin}/api/v1/listings/153146`, alarmMinutes: 180 });
  await panel.click('#wizClose');

  // ---- 3. The popup is ready to use; mark the Ram posted ----
  popup = await openPopup();
  assert.equal(await popup.$('#setup'), null, 'set-up is no longer offered');
  assert.equal(await tab(popup, 'ready').locator('.count').textContent(), '1');
  await tab(popup, 'ready').click();
  await popup.click('button[data-action="post"]'); // Mark posted
  await popup.click('button[data-action="markToday"]'); // it went up today
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
  await popup.screenshot({ path: join(shots, 'wizard-5-badge-todo.png') });
  await popup.click('button[data-action="takenDown"]');
  await popup.waitForFunction(() => document.querySelector('.tabs button[data-view="todo"] .count').textContent === '0');
  await popup.waitForFunction(async () => (await chrome.action.getBadgeText({})) === '');
  await popup.close();
  await panel.close();

  assert.deepEqual(errors, [], 'no console errors');
  facebook.assertNone();
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
  // leave nothing behind: the throwaway profile and the extension copy
  for (const d of [profileDir, extDir]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { /* still locked by the closing browser; every run makes its own folders, so a leftover does no harm */ } }
  site.close();
}
