import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDefaults, defaultSettings, feeGap, suggestedPriceNote, priceStepModel, profileFrom, settingsFromProfile, showsLowerPrice, chooseBasis, basisChangeNote, loadProfile, saveProfile, PROFILE_KEY, SETTINGS_VERSION, DEFAULT_SALESPERSON_TITLE } from '../extension/src/settings.js';
import { LEGAL, acceptLegal, legalIsCurrent, legalHosted, isPlaceholderUrl } from '../extension/src/legalLinks.js';
import { locationQuery } from '../extension/src/listingData.js';
import { buildTemplateDescription } from '../extension/src/rewriteTemplate.js';
import { vehicle, WAYNESBURG } from './helpers.js';

test('v0.1 settings ({ myStores, basis }) keep working and gain defaults', () => {
  const s = withDefaults({ myStores: [WAYNESBURG], basis: 'beforeFees' }, { name: 'Ron Lewis CDJR Waynesburg' });
  assert.equal(s.version, SETTINGS_VERSION);
  assert.deepEqual(s.myStores, [WAYNESBURG]);
  assert.equal(s.basis, 'beforeFees');
  assert.deepEqual(s.salesperson, { name: '', title: 'sales consultant', closingLine: '' });
  assert.deepEqual(s.dealer, { name: 'Ron Lewis CDJR Waynesburg', city: '', state: '', zip: '' }, 'no address on the website: the city is left for a person to type');
  assert.equal(s.priceNote, '');
  assert.equal(s.dailyCap, 10);
  assert.deepEqual(s.rewrite, { enabled: false, endpoint: '', key: '' });
  assert.deepEqual(s.defaults, { titleStatus: 'Clean', condition: 'Very good' });
  // "leave blank" is kept; nonsense falls back
  assert.deepEqual(withDefaults({ defaults: { titleStatus: '', condition: 'Excellent' } }).defaults, { titleStatus: '', condition: 'Excellent' });
  assert.deepEqual(withDefaults({ defaults: { titleStatus: 'Spotless', condition: 42 } }).defaults, { titleStatus: 'Clean', condition: 'Very good' });
});

test("the website's own address fills blank city, state and ZIP but never overrides what was typed", () => {
  const site = { name: WAYNESBURG, address: { street: '1 Example Way', city: 'Waynesburg', state: 'PA', zip: '15370', source: 'structured data' } };
  const fresh = withDefaults({ myStores: [WAYNESBURG] }, site);
  assert.deepEqual(fresh.dealer, { name: WAYNESBURG, city: 'Waynesburg', state: 'PA', zip: '15370' });
  const typed = withDefaults({ dealer: { name: 'Ron Lewis CDJR', city: 'Waynesburg', state: 'PA', zip: '15370' } }, { name: 'x', address: { city: 'Elsewhere', state: 'OH', zip: '43000' } });
  assert.deepEqual(typed.dealer, { name: 'Ron Lewis CDJR', city: 'Waynesburg', state: 'PA', zip: '15370' });
  const partial = withDefaults({ dealer: { city: 'Waynesburg' } }, site);
  assert.deepEqual(partial.dealer, { name: WAYNESBURG, city: 'Waynesburg', state: 'PA', zip: '15370' });
  assert.equal(defaultSettings(site, []).dealer.zip, '15370');
});

test('the city is never guessed from a store name, and a city a person clears stays clear unless the website gives one', () => {
  // A store name is a label (normalize.js shortLocation), not a town: whole, or a fragment like
  // 'Superstore', it would read "on the lot at X in <store name>" and be typed into Marketplace's location box.
  for (const store of ['Smith Chevrolet Buick GMC', 'Jones Toyota Superstore', 'Example Auto Mall', 'Smith Chevrolet of Dayton']) {
    const s = withDefaults({ myStores: [store] }, { name: store });
    assert.equal(s.dealer.city, '', store);
    assert.equal(locationQuery(s.dealer), '', `${store}: nothing to type into the location box`);
    assert.equal(defaultSettings({ name: store }, [{ location: store }]).dealer.city, '', `${store}: first-run defaults`);
  }
  // the wizard and Settings save a blank City box through withDefaults: it stays blank
  assert.equal(withDefaults({ myStores: ['Example Auto Mall'], dealer: { city: '', state: 'OH' } }, { name: 'Example Auto Mall' }).dealer.city, '');
  // the website's own address still fills a blank city
  const site = { name: 'Example Auto Mall', address: { city: 'Springfield', state: 'OH', zip: '', source: 'page text' } };
  assert.equal(withDefaults({ myStores: ['Example Auto Mall'], dealer: { city: '' } }, site).dealer.city, 'Springfield');
  // with no city the description names the dealership alone
  const s = withDefaults({ myStores: ['Example Auto Mall'] }, { name: 'Example Auto Mall' });
  const text = buildTemplateDescription({ vehicle: { year: 2020, make: 'Ford', model: 'F-150', mileage: 1000, location: 'Example Auto Mall' }, dealer: s.dealer, salesperson: { name: 'Pat' }, stores: s.myStores });
  assert.match(text, /^Pre-owned and on the lot at Example Auto Mall\.$/m);
});

test('bad input becomes safe defaults', () => {
  const s = withDefaults(null);
  assert.equal(s.basis, 'website');
  assert.deepEqual(s.myStores, []);
  assert.equal(withDefaults({ dailyCap: -3 }).dailyCap, 10);
  assert.equal(withDefaults({ dailyCap: 4.7 }).dailyCap, 4);
});

test('the fee gap is what most priced cars agree on, and it becomes the suggested price note', () => {
  const lot = [vehicle('usedNormal'), vehicle('certified'), vehicle('usedNoCarfax'), vehicle('usedNoPrice')];
  const fee = feeGap(lot);
  assert.equal(fee.gap, 490);
  assert.equal(fee.total, 3);
  assert.equal(fee.example.vin, lot[0].vin);
  assert.equal(suggestedPriceNote(490), 'Price includes the $490 doc fee; tax and tags extra.');
  assert.equal(suggestedPriceNote(490, 'beforeFees'), 'Price is before the $490 doc fee; tax and tags extra.');
  assert.equal(suggestedPriceNote(0), '');
  // no agreement: no gap
  const shown = (value) => ({ extra_fields: { lightning: { pricing: { high: { label: 'Was', value } } } } });
  assert.equal(feeGap([vehicle('usedNormal'), vehicle('certified', shown('30000')), vehicle('usedNoCarfax', shown('40000'))]).gap, 0);
});

test('the synced profile carries the person and dealer details but never the service key', async () => {
  const s = withDefaults({ myStores: [WAYNESBURG], salesperson: { name: 'Roger', title: 'sales consultant' }, dealer: { name: WAYNESBURG, city: 'Waynesburg', state: 'PA', zip: '15370' }, priceNote: 'Tax and tags extra.', dailyCap: 8, rewrite: { enabled: true, endpoint: 'http://localhost:8787', key: 'secret' } });
  const HOME = 'https://www.example-dealer.test';
  const p = profileFrom(s, HOME);
  assert.equal(p.origin, HOME, 'the profile remembers the website it was saved on');
  assert.equal(p.salesperson.name, 'Roger');
  assert.equal(p.dealer.zip, '15370');
  assert.equal(p.dailyCap, 8);
  assert.deepEqual(p.rewrite, { enabled: true, endpoint: 'http://localhost:8787' });
  assert.ok(!JSON.stringify(p).includes('secret'));

  // a fake chrome.storage.sync
  const store = {};
  const fake = { get: async (k) => ({ [k]: store[k] }), set: async (obj) => Object.assign(store, obj) };
  assert.equal(await saveProfile(s, fake, HOME), true);
  assert.equal((await loadProfile(fake)).salesperson.name, 'Roger');
  assert.equal((await loadProfile(fake)).origin, HOME);
  assert.ok(PROFILE_KEY in store);
  assert.equal(await loadProfile({ get: async () => { throw new Error('no sync'); } }), null);

  // the same website: everything carries over, even if the person edited the dealership name
  const same = settingsFromProfile({ ...p, dealer: { ...p.dealer, name: 'Ron Lewis CDJR' } }, { origin: HOME, name: WAYNESBURG });
  assert.deepEqual(same.myStores, [WAYNESBURG]);
  assert.equal(same.dealer.name, 'Ron Lewis CDJR');
  assert.equal(same.rewrite.key, '');
  assert.equal(same.salesperson.name, 'Roger');
  assert.equal(same.priceNote, 'Tax and tags extra.');
  // another website: only the person's own fields do; the dealership's are that website's
  const other = settingsFromProfile(p, { origin: 'https://www.some-other-dealer.test', name: 'Some Other Dealer', address: { city: 'Elsewhere', state: 'OH', zip: '43000' } });
  assert.deepEqual(other.myStores, []);
  assert.deepEqual(other.dealer, { name: 'Some Other Dealer', city: 'Elsewhere', state: 'OH', zip: '43000' });
  assert.equal(other.priceNote, '');
  assert.equal(other.basis, 'website');
  assert.equal(other.dailyCap, 10);
  assert.equal(other.salesperson.name, 'Roger');
  assert.deepEqual(other.defaults, { titleStatus: 'Clean', condition: 'Very good' });
  assert.equal(other.rewrite.endpoint, 'http://localhost:8787');
  // no origin to compare (a site without one): keep the profile, as before
  assert.equal(settingsFromProfile(p, {}).dealer.name, WAYNESBURG);
  // a profile saved before 0.4.0 has no origin key at all: kept whole, as before
  const legacy = { ...p };
  delete legacy.origin;
  assert.equal(settingsFromProfile(legacy, { origin: 'https://www.some-other-dealer.test', name: 'Some Other Dealer' }).priceNote, 'Tax and tags extra.');
  // a profile saved with no website (from a Facebook tab, before the popup
  // refused that) names no dealership: only the person's own fields carry
  const nowhere = settingsFromProfile({ ...p, origin: '' }, { origin: 'https://www.some-other-dealer.test', name: 'Some Other Dealer' });
  assert.deepEqual(nowhere.dealer, { name: 'Some Other Dealer', city: '', state: '', zip: '' });
  assert.deepEqual([nowhere.priceNote, nowhere.dailyCap, nowhere.basis, nowhere.myStores], ['', 10, 'website', []]);
  assert.equal(nowhere.salesperson.name, 'Roger', 'the person\'s own fields still carry');
  // and no profile is written without the website it belongs to
  const before = JSON.stringify(store);
  assert.equal(await saveProfile(s, fake, ''), false);
  assert.equal(await saveProfile(s, fake), false);
  assert.equal(JSON.stringify(store), before, 'nothing was written');
  assert.equal(settingsFromProfile(null), null);
  assert.equal(DEFAULT_SALESPERSON_TITLE, 'sales consultant');
});

test('the lower second price is a basis only on a website that shows one; without a scan the previous choice stands', () => {
  const lot = [vehicle('usedNormal'), vehicle('certified')]; // both show a lower second price
  assert.equal(showsLowerPrice(lot), true);
  assert.equal(showsLowerPrice([{ price: 20000 }, { price: 21000, priceBeforeFees: 22000 }]), false, 'a higher second number is not a lower price');
  assert.equal(showsLowerPrice([]), false);
  assert.equal(chooseBasis('beforeFees', 'website', lot), 'beforeFees');
  assert.equal(chooseBasis('beforeFees', 'website', [{ price: 20000 }]), 'website', 'not offered: coerced');
  assert.equal(chooseBasis('website', 'beforeFees', lot), 'website');
  assert.equal(chooseBasis('website', 'beforeFees', null), 'beforeFees', 'no scan yet: a Save must not flip a synced choice');
  assert.equal(chooseBasis('beforeFees', 'website', null), 'website');
});

// Settings and set-up's Price step say the same before a change of basis:
// how many listings the person has here, and that the change is for new
// posts while those listings keep the price they were posted at. Never a
// price edit to make: the posting rules allow one only when the website
// changes.
test('the note before a change of Price to post counts the listings and says they keep the price they were posted at', () => {
  assert.equal(basisChangeNote(0), '');
  assert.equal(basisChangeNote(undefined), '');
  assert.equal(basisChangeNote(1), 'You have one posted listing on this website. A change here is for new posts: that listing keeps the price it was posted at, and rescans keep checking it against the website on that price.');
  assert.equal(basisChangeNote(3), 'You have 3 posted listings on this website. A change here is for new posts: those listings keep the price they were posted at, and rescans keep checking each one against the website on that price.');
  for (const n of [1, 3]) {
    assert.doesNotMatch(basisChangeNote(n), /[<>&]/, 'plain text: the popup and the wizard put it in a paragraph as it is');
    assert.doesNotMatch(basisChangeNote(n), /edit|To do|Facebook may tell/i, 'never a price edit the website did not make');
  }
});

test("the wizard's Price step model: the lower price only on a website that shows one, the gap's wording, and the example's prices only", () => {
  const lot = [vehicle('usedNormal'), vehicle('certified'), vehicle('usedNoCarfax'), vehicle('usedNoPrice')];
  const m = priceStepModel(lot);
  assert.equal(m.showsLower, true);
  assert.equal(m.gap, 490);
  assert.equal(m.suggested, 'Price includes the $490 doc fee; tax and tags extra.');
  assert.deepEqual(m.example, { price: lot[0].price, priceBeforeFees: lot[0].priceBeforeFees, priceLabel: lot[0].priceLabel }, 'three prices, not the whole car: the model sits in the wizard\'s saved state');
  assert.equal(priceStepModel(lot, 'beforeFees').suggested, 'Price is before the $490 doc fee; tax and tags extra.');
  // a website with one price per car: nothing to choose, nothing to suggest
  const plain = priceStepModel([{ price: 20000 }, { price: 21000, priceBeforeFees: 22000 }]);
  assert.deepEqual(plain, { showsLower: false, gap: 0, example: null, suggested: '' });
  assert.deepEqual(priceStepModel([]), { showsLower: false, gap: 0, example: null, suggested: '' });
  assert.deepEqual(priceStepModel(null), { showsLower: false, gap: 0, example: null, suggested: '' });
  // the basis is chosen through chooseBasis, from the model as from the entries: a radio value the site cannot support never lands in settings
  assert.equal(chooseBasis('beforeFees', 'website', m), 'beforeFees');
  assert.equal(chooseBasis('beforeFees', 'beforeFees', plain), 'website', 'not shown here: coerced, even against the previous choice');
  assert.equal(chooseBasis('website', 'beforeFees', m), 'website');
  assert.equal(chooseBasis('beforeFees', 'website', null), 'website', 'no read yet: the previous choice stands');
});

test('first-run defaults: the store matching the site name; the price note is only suggested, never filled in', () => {
  const site = { name: WAYNESBURG, title: 'Used Vehicles | ' + WAYNESBURG };
  const lot = [vehicle('usedNormal'), vehicle('certified')];
  const s = defaultSettings(site, lot);
  assert.deepEqual(s.myStores, [WAYNESBURG]);
  assert.equal(s.dealer.name, WAYNESBURG);
  assert.equal(s.dealer.city, '', 'the site gives no address here, so the city is not guessed from the store name');
  assert.equal(s.priceNote, '', 'a person decides what the price gap means');
  assert.match(suggestedPriceNote(feeGap(lot).gap, s.basis), /\$490 doc fee/);
});

test('the Terms and Privacy acceptance: blank by default, garbage becomes blank, and it follows the person to any website', () => {
  const blank = { version: '', acceptedAt: '' };
  assert.deepEqual(withDefaults({}).legal, blank);
  assert.deepEqual(withDefaults({ legal: 'yes' }).legal, blank);
  assert.deepEqual(withDefaults({ legal: 42 }).legal, blank);
  assert.deepEqual(withDefaults({ legal: { version: 42, acceptedAt: null } }).legal, blank);
  assert.deepEqual(withDefaults({ legal: { version: LEGAL.version, acceptedAt: ['x'] } }).legal, { version: LEGAL.version, acceptedAt: '' });
  assert.equal(legalIsCurrent(blank), false);
  // the placeholders and the edition
  assert.ok(Object.isFrozen(LEGAL));
  assert.match(LEGAL.version, /^\d{4}-\d{2}-\d{2}/);
  for (const k of ['termsUrl', 'privacyUrl', 'rulesUrl']) assert.match(LEGAL[k], /^https:\/\//, `${k} is an https address`);
  // what the wizard's Terms step and the Settings tick record
  const accepted = acceptLegal('2026-09-28T12:00:00.000Z');
  assert.deepEqual(accepted, { version: LEGAL.version, acceptedAt: '2026-09-28T12:00:00.000Z' });
  assert.match(acceptLegal().acceptedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(legalIsCurrent(accepted), true);
  assert.equal(legalIsCurrent({ version: 'older', acceptedAt: '2026-01-01T00:00:00.000Z' }), false, 'an older edition re-asks');
  // the round trip through the synced profile: it is the person's, so it carries over to another dealership's website too
  const s = withDefaults({ salesperson: { name: 'Roger' }, legal: accepted });
  assert.deepEqual(s.legal, accepted);
  const HOME = 'https://www.example-dealer.test';
  const p = profileFrom(s, HOME);
  assert.deepEqual(p.legal, accepted);
  assert.deepEqual(settingsFromProfile(p, { origin: HOME, name: 'Home Dealer' }).legal, accepted);
  assert.deepEqual(settingsFromProfile(p, { origin: 'https://www.some-other-dealer.test', name: 'Some Other Dealer' }).legal, accepted);
  // a profile saved before the Terms step existed
  const { legal, ...older } = p;
  assert.deepEqual(settingsFromProfile(older, { origin: HOME }).legal, blank);
});

test('a placeholder legal address is one nobody can read; the Terms step gates only once both documents are hosted', () => {
  // the predicate, against sample addresses (the live constant changes when the site is up)
  for (const url of ['https://lotcurrent.example/terms', 'https://www.lotcurrent.example/privacy/', 'https://LOTCURRENT.EXAMPLE', 'https://example', '', null, 'not a url', 'http://lotcurrent.com/terms', 'ftp://lotcurrent.com/terms']) {
    assert.equal(isPlaceholderUrl(url), true, `${url} is a placeholder`);
  }
  for (const url of ['https://lotcurrent.com/terms', 'https://www.fixture.lotcurrent.com/privacy', 'https://example.com/terms', 'https://myexample.net/terms']) {
    assert.equal(isPlaceholderUrl(url), false, `${url} could be hosted`);
  }
  // legalHosted is that predicate over the live addresses, whatever they are today
  assert.equal(legalHosted(), !isPlaceholderUrl(LEGAL.termsUrl) && !isPlaceholderUrl(LEGAL.privacyUrl));
});

test("the Ready list's order and the new-arrival window are this website's settings: defaults, limits, and never in the synced profile", () => {
  const s = withDefaults({});
  assert.equal(s.readySort, 'newest');
  assert.equal(s.newDays, 7);
  assert.equal(withDefaults({ readySort: 'price' }).readySort, 'price');
  assert.equal(withDefaults({ readySort: 'longest' }).readySort, 'longest');
  assert.equal(withDefaults({ readySort: 'name' }).readySort, 'name');
  assert.equal(withDefaults({ readySort: 'sideways' }).readySort, 'newest', 'an unknown order is the default');
  assert.equal(withDefaults({ newDays: 14 }).newDays, 14);
  assert.equal(withDefaults({ newDays: '3' }).newDays, 3);
  assert.equal(withDefaults({ newDays: 0 }).newDays, 7);
  assert.equal(withDefaults({ newDays: 45 }).newDays, 30);
  assert.equal(withDefaults({ newDays: 2.9 }).newDays, 2);
  assert.equal(withDefaults({ newDays: 'soon' }).newDays, 7);
  // the profile carries neither, so neither follows the person to another website, nor comes back from the profile on this one
  const p = profileFrom(withDefaults({ readySort: 'price', newDays: 14 }), 'https://www.example-dealer.test');
  assert.ok(!('readySort' in p) && !('newDays' in p));
  const seeded = settingsFromProfile(p, { origin: 'https://www.example-dealer.test' });
  assert.equal(seeded.readySort, 'newest');
  assert.equal(seeded.newDays, 7);
});

// ---------- Settings, Save: says when no dealership name is set ----------
import { readFileSync } from 'node:fs';
import { NO_DEALER_NAME, dealerNameMissing } from '../extension/src/settings.js';
import { checkClosingLine, cleanClosingLine } from '../extension/src/rewriteTemplate.js';
import { DEFAULT_DAILY_CAP } from '../extension/src/cap.js';
import { MIN_NEW_DAYS, MAX_NEW_DAYS, DEFAULT_NEW_DAYS } from '../extension/src/readyList.js';

// popup.js onSettingsSubmit, as written, with the page around it stubbed: the form's fields, storage and the note by the Save button.
async function saveSettings({ fields, settings = null, siteName = '', origin = 'https://www.example-motors.test' }) {
  const src = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function onSettingsSubmit(');
  assert.ok(start >= 0, 'onSettingsSubmit is defined');
  // the website's own name comes with its last scan (popup.js knownSite)
  const state = { origin, siteName, settings, snapshot: siteName ? { site: { name: siteName }, vehicles: {} } : null, site: null };
  const saved = [];
  const note = { textContent: '' };
  const said = [];
  class FormData {
    get(k) { return k in fields ? fields[k] : null; }
    getAll(k) { return k in fields ? [].concat(fields[k]) : []; }
    has(k) { return k in fields; }
  }
  const scope = {
    state, FormData, document: { activeElement: null },
    accountAction: () => { throw new Error('no account button was pressed'); },
    render: () => {}, setStatus: (text, kind) => said.push([text, kind]),
    checkClosingLine, cleanClosingLine, withDefaults, chooseBasis, DEFAULT_SALESPERSON_TITLE, DEFAULT_DAILY_CAP, MIN_NEW_DAYS, MAX_NEW_DAYS, DEFAULT_NEW_DAYS,
    legalHosted: () => false, acceptLegal: () => ({}), chrome: {}, rescanOrigins: () => [],
    save: async (name) => { saved.push([name, state.settings]); return true; },
    setSiteAuto: async () => {},
    $: (id) => (id === 'saved' ? note : null),
    NO_DEALER_NAME, dealerNameMissing,
    knownSite: () => state.snapshot?.site || {}, NO_SITE_TEXT: 'no website open',
    saveProfile: async () => {}, ownListings: () => 0, update: async () => true, askChrome: async () => false,
  };
  const submit = new Function(...Object.keys(scope), `${src.slice(start, src.indexOf('\n}\n', start) + 2)}\nreturn onSettingsSubmit;`)(...Object.values(scope));
  await submit({ target: { id: 'settings', querySelector: () => null }, preventDefault: () => {} });
  return { saved, note: note.textContent, said };
}

test('Settings saves with no dealership name but says so: nothing can be posted until one is typed', async () => {
  const fields = { salespersonName: 'Sam', salespersonTitle: 'sales consultant', closingLine: '', dealerName: '', dealerCity: 'Springfield', dealerState: 'oh', dealerZip: '43215', priceNote: '', dailyCap: '10', newDays: '7' };
  // a website that gives no name, and nobody typed one: the rest is saved, and the note says what is missing
  const blank = await saveSettings({ fields });
  assert.equal(blank.saved.length, 1, 'the other settings are kept');
  assert.equal(blank.saved[0][1].salesperson.name, 'Sam');
  assert.equal(blank.saved[0][1].dealer.name, '');
  assert.equal(blank.note, `Saved. Click Rescan website to apply. ${NO_DEALER_NAME}`);
  // typed in Settings, or read from the website: nothing to say
  assert.equal((await saveSettings({ fields: { ...fields, dealerName: 'Example Motors' } })).note, 'Saved. Click Rescan website to apply.');
  const fromSite = await saveSettings({ fields, siteName: 'Example Motors' });
  assert.equal(fromSite.saved[0][1].dealer.name, 'Example Motors');
  assert.equal(fromSite.note, 'Saved. Click Rescan website to apply.');
  // a box cleared by mistake keeps the name already set
  const kept = await saveSettings({ fields, settings: withDefaults({ dealer: { name: 'Example Motors' } }) });
  assert.equal(kept.saved[0][1].dealer.name, 'Example Motors');
  assert.equal(kept.note, 'Saved. Click Rescan website to apply.');
  // with no dealership website open nothing is saved (settings belong to a website), and there is no dealership to name yet
  const none = await saveSettings({ fields, origin: null });
  assert.deepEqual([none.saved, none.note, none.said], [[], '', [['no website open', 'error']]]);
});

test('Settings saves a price note the checks would refuse: the warning under it holds nothing back', async () => {
  const note = 'Tax, title and fees go to the state, not the dealer. Text Sam.';
  const fields = { salespersonName: 'Sam', salespersonTitle: 'sales consultant', closingLine: '', dealerName: 'Example Motors', dealerCity: 'Springfield', dealerState: 'oh', dealerZip: '43215', priceNote: note, dailyCap: '10', newDays: '7' };
  const r = await saveSettings({ fields });
  assert.equal(r.saved.length, 1);
  assert.equal(r.saved[0][1].priceNote, note);
  assert.equal(r.note, 'Saved. Click Rescan website to apply.');
});
