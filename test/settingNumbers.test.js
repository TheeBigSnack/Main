// A number the salesperson or the dealership typed into Settings goes into
// every description: the sign-off says the role and the name, and every
// description names the dealership. The checks hold every number in a
// description to the website's data for the car (runGuardrails), so a role
// such as "2nd shift sales" kept every Marketplace form shut with a reason
// ('"2" isn't in the website's data for this car') that never named the
// role. The checks still fail such a description; the reason now names the
// setting, its value and how to write it, and set-up and Settings warn as
// soon as the field holds such a number.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplateDescription, runGuardrails, ruleProblems, settingNumberWarning, settingNumberNotice, numbersAsWords } from '../extension/src/rewriteTemplate.js';

const CAR = { vin: '1TESTVEH0NA000123', year: 2021, make: 'Example', model: 'Sedan', trim: 'LX', name: '2021 Example Sedan LX', mileage: 34567, price: 20986, features: ['Heated Seats', 'Backup Camera', 'Bluetooth', 'Remote Start'], descriptionRaw: '' };
const DEALER = { name: 'Example Motors', city: 'Springfield' };
const ctxFor = ({ vehicle = CAR, dealer = DEALER, salesperson = { name: 'Sam', title: 'sales consultant' } } = {}) => ({ vehicle, dealer, salesperson, priceNote: '', price: vehicle.price });
// the template for these settings, and what the checks say of it
function checked(c) {
  const text = buildTemplateDescription(c);
  return { text, g: runGuardrails(text, c) };
}

test('a role with a number fails the checks as before, and the reason names the role, its value and how to write it', () => {
  const plain = checked(ctxFor());
  assert.deepEqual(plain.g.problems, [], 'the template passes with a role that has no number');
  for (const name of ['Sam', '']) {
    const c = ctxFor({ salesperson: { name, title: '2nd shift sales' } });
    const { text, g } = checked(c);
    assert.match(text, /2nd shift sales at Example Motors\./, 'the sign-off says the role as typed');
    assert.equal(g.ok, false, 'the description still fails');
    assert.deepEqual(ruleProblems(g), [{
      code: 'setting-number',
      text: 'Your role "2nd shift sales" has a number in it, and every number in a description must match the website\'s data for the car; change it in Settings (Your role), for example to "Second shift sales"',
    }], name || 'no name');
  }
  // several numbers, one reason; a number no word can stand in for gets no example
  const team = checked(ctxFor({ salesperson: { name: 'Sam', title: 'Team 3 Sales' } })).g;
  assert.deepEqual(ruleProblems(team).map((p) => p.text), ['Your role "Team 3 Sales" has a number in it, and every number in a description must match the website\'s data for the car; change it in Settings (Your role), for example to "Team Three Sales"']);
  const allDay = checked(ctxFor({ salesperson: { name: 'Sam', title: 'sales, 24/7' } })).g;
  assert.deepEqual(ruleProblems(allDay).map((p) => p.text), ['Your role "sales, 24/7" has a number in it, and every number in a description must match the website\'s data for the car; change it in Settings (Your role): write the number as a word or leave it out']);
  // a role that reads as a mileage is the same one reason, not a mileage the website doesn't show as well
  const club = checked(ctxFor({ salesperson: { name: 'Sam', title: '30,000 miles club' } })).g;
  assert.deepEqual(ruleProblems(club).map((p) => p.code), ['setting-number']);
  assert.match(club.problems[0].text, /^Your role "30,000 miles club" has a number in it/);
});

test('the reason names the role only when the number comes from the role alone', () => {
  const c = ctxFor({ salesperson: { name: 'Sam', title: '2nd shift sales' } });
  const { text } = checked(c);
  // another number the website doesn't give is named as before, beside the role
  const axle = runGuardrails(text.replace('Highlights:', 'A 3.92 axle. Highlights:'), c);
  assert.deepEqual(ruleProblems(axle).map((p) => p.code), ['setting-number', 'unknown-number']);
  assert.equal(ruleProblems(axle)[1].text, '"3.92" isn\'t in the website\'s data for this car');
  // the same number elsewhere in the text is not the role's alone: the plain reason, which stays true once the role changes
  const keys = runGuardrails(text.replace('Highlights:', 'Find it in row 2. Highlights:'), c);
  assert.deepEqual(ruleProblems(keys), [{ code: 'unknown-number', text: '"2" isn\'t in the website\'s data for this car' }]);
  // the role is set aside only where it stands as words of its own: a role of "2" does not hide a wrong "12,000 miles"
  const bare = ctxFor({ salesperson: { name: 'Sam', title: '2' } });
  const wrongMiles = runGuardrails(buildTemplateDescription(bare).replace('34,567 miles', '12,000 miles'), bare);
  assert.deepEqual(ruleProblems(wrongMiles).map((p) => p.code), ['setting-number', 'unknown-number', 'mileage-mismatch']);
  // a car whose own data holds the number passes: a number in the role keeps the form shut for nearly every car, not every one
  const rowSeats = { ...CAR, features: [...CAR.features, '2nd Row Captain\'s Chairs'] };
  assert.deepEqual(checked(ctxFor({ vehicle: rowSeats, salesperson: { name: 'Sam', title: '2nd shift sales' } })).g.problems, []);
});

test('a name with a number gets the same reason; a dealership name with a number passes unless it reads as a price or a mileage', () => {
  const named = checked(ctxFor({ salesperson: { name: 'Sam 2', title: 'sales consultant' } })).g;
  assert.equal(named.ok, false);
  assert.deepEqual(ruleProblems(named), [{
    code: 'setting-number',
    text: 'Your name "Sam 2" has a number in it, and every number in a description must match the website\'s data for the car; change it in Settings (Your name), for example to "Sam"',
  }]);
  const glued = checked(ctxFor({ salesperson: { name: 'Sam2', title: 'sales consultant' } })).g;
  assert.deepEqual(ruleProblems(glued).map((p) => p.text), ['Your name "Sam2" has a number in it, and every number in a description must match the website\'s data for the car; change it in Settings (Your name), for example to "Sam"']);
  const digits = checked(ctxFor({ salesperson: { name: '22', title: 'sales consultant' } })).g;
  assert.deepEqual(ruleProblems(digits).map((p) => p.text), ['Your name "22" has a number in it, and every number in a description must match the website\'s data for the car; change it in Settings (Your name): leave the number out'], 'no letter left: no example');
  // both: each setting is named
  const both = checked(ctxFor({ salesperson: { name: 'Sam 2', title: '3rd shift sales' } })).g;
  assert.deepEqual(ruleProblems(both).map((p) => p.text.slice(0, 30)), ['Your role "3rd shift sales" ha', 'Your name "Sam 2" has a number']);

  // the dealership's name is among the facts the number check reads, so its numbers pass
  for (const name of ['Route 19 Motors', '1st Choice Auto', 'I-79 Auto 2000']) {
    assert.deepEqual(checked(ctxFor({ dealer: { name, city: 'Springfield' } })).g.problems, [], name);
  }
  // a name that reads as a mileage or a price fails the mileage or price check; the reason names it
  const mile = checked(ctxFor({ dealer: { name: '8 Mile Auto', city: 'Springfield' } })).g;
  assert.equal(mile.ok, false);
  assert.deepEqual(ruleProblems(mile), [{
    code: 'setting-number',
    text: 'Your dealership\'s name "8 Mile Auto" reads as a price or a mileage, and every price and mileage in a description must match the listing; change it in Settings (Dealership name), for example to "Eight Mile Auto"',
  }]);
  const down = checked(ctxFor({ dealer: { name: 'Auto 1500 Down', city: 'Springfield' } })).g;
  assert.deepEqual(ruleProblems(down).map((p) => p.text), ['Your dealership\'s name "Auto 1500 Down" reads as a price or a mileage, and every price and mileage in a description must match the listing; change it in Settings (Dealership name): write the number as a word']);
});

test('set-up and Settings warn about a number in the role or the name, and a dealership name that reads as a price or a mileage', () => {
  assert.equal(settingNumberWarning('role', '2nd shift sales'), 'A number in your role ("2nd") keeps the Marketplace form shut for nearly every car: every number in a description must match the website\'s data for the car. Write the number as a word or leave it out, for example "Second shift sales".');
  assert.equal(settingNumberWarning('role', 'sales, 24/7'), 'A number in your role ("24/7") keeps the Marketplace form shut for nearly every car: every number in a description must match the website\'s data for the car. Write the number as a word or leave it out.');
  assert.equal(settingNumberWarning('name', 'Sam 2'), 'A number in your name ("2") keeps the Marketplace form shut for nearly every car: every number in a description must match the website\'s data for the car. Leave it out, for example "Sam".');
  assert.equal(settingNumberWarning('dealer', '8 Mile Auto'), 'The dealership\'s name reads as a price or a mileage ("8 Mile"), which keeps the Marketplace form shut for nearly every car: every price and mileage in a description must match the listing. Write the number as a word, for example "Eight Mile Auto".');
  for (const [field, value] of [['role', 'sales consultant'], ['role', 'Second shift sales'], ['role', ''], ['name', 'Sam'], ['name', ''], ['dealer', 'Route 19 Motors'], ['dealer', 'Example Motors'], ['dealer', ''], ['role', undefined]]) {
    assert.equal(settingNumberWarning(field, value), '', `${field}: ${value}`);
  }
  // the example is a suggestion the checks pass
  for (const [field, value, example] of [['role', '2nd shift sales', 'Second shift sales'], ['dealer', '8 Mile Auto', 'Eight Mile Auto']]) {
    assert.ok(settingNumberWarning(field, value).includes(`"${example}"`));
    const c = field === 'role' ? ctxFor({ salesperson: { name: 'Sam', title: example } }) : ctxFor({ dealer: { name: example, city: 'Springfield' } });
    assert.deepEqual(checked(c).g.problems, [], example);
  }
});

test('numbers as words: ordinals and small numbers, with a capital where the words around have one', () => {
  assert.equal(numbersAsWords('2nd shift sales'), 'Second shift sales');
  assert.equal(numbersAsWords('sales, 2nd shift'), 'sales, second shift');
  assert.equal(numbersAsWords('Team 3 Sales'), 'Team Three Sales');
  assert.equal(numbersAsWords('8 Mile Auto'), 'Eight Mile Auto');
  assert.equal(numbersAsWords('12th Street Motors'), 'Twelfth Street Motors');
  assert.equal(numbersAsWords('sales, 24/7'), '', 'a number no word stands in for: no example');
  assert.equal(numbersAsWords('Route19'), '', 'a number inside a word: no example');
  assert.equal(numbersAsWords('sales consultant'), 'sales consultant');
});

// ---------- the warning in set-up and Settings ----------
// Shown under the field as soon as it holds such a number: drawn with the
// step or the form, and brought up to date as the person types. The field
// is described by it (aria-describedby), and a live region beside it says
// the same without the number and the example, so a screen reader hears it
// when it appears (and only then: the tests after these).
import { wiz, wizardHtml, handleWizardInput } from '../extension/wizard.js';
import { withDefaults } from '../extension/src/settings.js';
import { loadPopup, POPUP_ORIGIN } from './popupHarness.js';
import { siteKeys } from '../extension/src/storageKeys.js';
import { MY_STORE } from './helpers.js';

const unesc = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
// the input with this attribute, the warning the page draws under it (not a live region: it changes on every key), and the live region beside it
const inputWith = (html, attr) => (new RegExp(`<input\\b[^>]*\\s${attr}[^>]*>`).exec(html) || [''])[0];
const region = (html, id) => {
  const m = new RegExp(`<div id="${id}">(.*?)</div>(?=\\s*(?:<|$))`, 's').exec(html);
  return m ? unesc(m[1].replace(/<[^>]+>/g, '')) : null;
};
const liveRegion = (html, id) => {
  const m = new RegExp(`<div id="${id}" class="sr" aria-live="polite">(.*?)</div>`, 's').exec(html);
  return m ? unesc(m[1]) : null;
};
const ROLE_WARNING = settingNumberWarning('role', '2nd shift sales');
const DEALER_WARNING = settingNumberWarning('dealer', '8 Mile Auto');

test('set-up warns under the role, the name and the dealership name while they hold such a number, and as the person types', () => {
  const elements = new Map();
  globalThis.document = { getElementById: (id) => { if (!elements.has(id)) elements.set(id, { id, innerHTML: '' }); return elements.get(id); } };
  wiz.active = true;
  wiz.step = 'you';
  wiz.settings = withDefaults({ salesperson: { name: 'Sam', title: '2nd shift sales' }, dealer: { name: '8 Mile Auto', city: 'Springfield', state: 'OH', zip: '43215' } });
  let html = wizardHtml();
  assert.match(inputWith(html, 'id="wizTitle"'), /aria-describedby="wizTitleWarn"/, 'the role field is described by its warning');
  assert.match(inputWith(html, 'id="wizName"'), /aria-describedby="wizNameWarn"/);
  assert.equal(region(html, 'wizTitleWarn'), ROLE_WARNING, 'a role with a number is warned about when the step opens');
  assert.equal(liveRegion(html, 'wizTitleSay'), settingNumberNotice('role', '2nd shift sales'), 'the live region says it without the number and the example');
  assert.equal(settingNumberNotice('role', '2nd shift sales'), 'A number in your role keeps the Marketplace form shut for nearly every car: every number in a description must match the website\'s data for the car. Write the number as a word or leave it out.');
  assert.equal(region(html, 'wizNameWarn'), '', 'a name with no number is not');
  assert.equal(liveRegion(html, 'wizNameSay'), '');
  wiz.step = 'address';
  html = wizardHtml();
  assert.match(inputWith(html, 'id="wizDealer"'), /aria-describedby="wizDealerWarn"/);
  assert.equal(region(html, 'wizDealerWarn'), DEALER_WARNING);
  assert.equal(liveRegion(html, 'wizDealerSay'), 'The dealership\'s name reads as a price or a mileage, which keeps the Marketplace form shut for nearly every car: every price and mileage in a description must match the listing. Write the number as a word.');

  // typing: the warning follows the field
  handleWizardInput({ id: 'wizDealer', value: 'Route 19 Motors' });
  assert.equal(elements.get('wizDealerWarn').innerHTML, '', 'a dealership name whose number reads as neither a price nor a mileage');
  handleWizardInput({ id: 'wizTitle', value: 'sales consultant' });
  assert.equal(elements.get('wizTitleWarn').innerHTML, '');
  handleWizardInput({ id: 'wizTitle', value: '2nd shift sales' });
  assert.match(elements.get('wizTitleWarn').innerHTML, /^<div class="banner warn">A number in your role \(&quot;2nd&quot;\) keeps the Marketplace form shut/);
  handleWizardInput({ id: 'wizName', value: 'Sam 2' });
  assert.equal(unesc(elements.get('wizNameWarn').innerHTML.replace(/<[^>]+>/g, '')), settingNumberWarning('name', 'Sam 2'));
  handleWizardInput({ id: 'wizCity', value: '8 Mile' }); // another field: nothing to say
  assert.ok(!elements.has('wizCityWarn'));

  wiz.step = 'you';
  wiz.settings = withDefaults({ salesperson: { name: 'Sam', title: 'Second shift sales' } });
  assert.equal(region(wizardHtml(), 'wizTitleWarn'), '', 'no warning for a role with no number');
  wiz.active = false;
});

test('Settings warns under Your role, Your name and Dealership name while they hold such a number, and as the person types', async () => {
  const k = siteKeys(POPUP_ORIGIN);
  const settings = { ...MY_STORE, salesperson: { name: 'Sam', title: '2nd shift sales' }, dealer: { name: '8 Mile Auto', city: 'Springfield', state: 'OH', zip: '43215' } };
  const p = await loadPopup({ local: { [k.settings]: settings } });
  await p.tab('settings');
  const html = p.panel();
  assert.match(inputWith(html, 'name="salespersonTitle"'), /aria-describedby="salespersonTitleWarn"/);
  assert.match(inputWith(html, 'name="salespersonName"'), /aria-describedby="salespersonNameWarn"/);
  assert.match(inputWith(html, 'name="dealerName"'), /aria-describedby="dealerNameWarn"/);
  assert.equal(region(html, 'salespersonTitleWarn'), ROLE_WARNING);
  assert.equal(liveRegion(html, 'salespersonTitleSay'), settingNumberNotice('role', '2nd shift sales'));
  assert.equal(region(html, 'salespersonNameWarn'), '');
  assert.equal(liveRegion(html, 'salespersonNameSay'), '');
  assert.equal(region(html, 'dealerNameWarn'), DEALER_WARNING);
  assert.equal(liveRegion(html, 'dealerNameSay'), settingNumberNotice('dealer', '8 Mile Auto'));

  const type = (name, value) => p.el('panel').listeners.input({ target: { name, value } });
  type('salespersonTitle', 'Second shift sales');
  assert.equal(p.el('salespersonTitleWarn').innerHTML, '');
  type('salespersonTitle', 'Team 3 sales');
  assert.equal(unesc(p.el('salespersonTitleWarn').innerHTML.replace(/<[^>]+>/g, '')), settingNumberWarning('role', 'Team 3 sales'));
  type('dealerName', 'Eight Mile Auto');
  assert.equal(p.el('dealerNameWarn').innerHTML, '');

  // the same settings with no such number: nothing to warn about
  const q = await loadPopup({ local: { [k.settings]: { ...settings, salesperson: { name: 'Sam', title: 'sales consultant' }, dealer: { ...settings.dealer, name: 'Route 19 Motors' } } } });
  await q.tab('settings');
  for (const id of ['salespersonTitleWarn', 'salespersonNameWarn', 'dealerNameWarn']) assert.equal(region(q.panel(), id), '', id);
});

// ---------- what a screen reader hears while the person types ----------
// The warning under the field follows every key (it quotes the number and a
// way to write the whole value), and the field is described by it. A screen
// reader speaks a live region each time it is written, so the live region is
// a separate one that is written only when the warning comes or goes, never
// on a key that leaves it standing.
// An element that counts the writes to it, as a screen reader would speak each write to a live region.
function countingElement(id) {
  let html = '';
  const el = { id, writes: 0 };
  Object.defineProperty(el, 'innerHTML', { get: () => html, set: (v) => { html = String(v); el.writes += 1; }, configurable: true });
  Object.defineProperty(el, 'textContent', { get: () => unesc(html.replace(/<[^>]+>/g, '')), set: (v) => { html = String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); el.writes += 1; }, configurable: true });
  return el;
}
// the id of the live region the page draws for this field, and the id the field is described by
function regionsOf(html, field, inputAttr) {
  const live = new RegExp(`<div id="(${field}\\w*)"[^>]*\\saria-live="polite"`).exec(html);
  const described = /aria-describedby="([^"]+)"/.exec(inputWith(html, inputAttr));
  return { live: live && live[1], described: described && described[1] };
}
const prefixes = (value) => [...value].map((_, i) => value.slice(0, i + 1));
const text = (el) => el.textContent.trim();

test('typing a role in set-up: the warning under it follows every key, and the live region is written only when the warning comes or goes', () => {
  wiz.active = true;
  wiz.step = 'you';
  wiz.settings = withDefaults({ salesperson: { name: 'Sam', title: 'sales consultant' }, dealer: { name: 'Example Motors', city: 'Springfield', state: 'OH', zip: '43215' } });
  const html = wizardHtml();
  const { live, described } = regionsOf(html, 'wizTitle', 'id="wizTitle"');
  assert.ok(live, 'a live region for the role');
  const elements = new Map();
  globalThis.document = { getElementById: (id) => { if (!elements.has(id)) elements.set(id, countingElement(id)); return elements.get(id); } };
  const liveEl = document.getElementById(live);
  const type = (value) => handleWizardInput({ id: 'wizTitle', value });

  for (const value of prefixes('2nd shift sales')) type(value);
  assert.equal(liveEl.writes, 1, `the live region is spoken once, when the warning comes, not on each of the 15 keys (written ${liveEl.writes} times)`);
  assert.ok(text(liveEl), 'what it says');
  assert.equal(text(document.getElementById(described)), settingNumberWarning('role', '2nd shift sales'), 'the field is described by the whole warning, as typed so far');
  // deleting back to nothing: written once more, when the warning goes
  for (const value of prefixes('2nd shift sales').reverse().slice(1)) type(value);
  type('');
  assert.equal(liveEl.writes, 2);
  assert.equal(text(liveEl), '');
  assert.equal(text(document.getElementById(described)), '');
  // another number: the warning comes again, and is spoken again
  for (const value of prefixes('Team 3')) type(value);
  assert.equal(liveEl.writes, 3);
  wiz.active = false;
});

test('typing a role in Settings: the warning under it follows every key, and the live region is written only when the warning comes or goes', async () => {
  const k = siteKeys(POPUP_ORIGIN);
  const p = await loadPopup({ local: { [k.settings]: { ...MY_STORE, salesperson: { name: 'Sam', title: 'sales consultant' }, dealer: { name: 'Example Motors', city: 'Springfield', state: 'OH', zip: '43215' } } } });
  await p.tab('settings');
  const { live, described } = regionsOf(p.panel(), 'salespersonTitle', 'name="salespersonTitle"');
  assert.ok(live, 'a live region for the role');
  const liveEl = p.el(live);
  const fresh = countingElement(live);
  Object.defineProperty(liveEl, 'innerHTML', Object.getOwnPropertyDescriptor(fresh, 'innerHTML'));
  Object.defineProperty(liveEl, 'textContent', Object.getOwnPropertyDescriptor(fresh, 'textContent'));
  const writes = () => fresh.writes;
  const type = (value) => p.el('panel').listeners.input({ target: { name: 'salespersonTitle', value } });

  for (const value of prefixes('2nd shift sales')) type(value);
  assert.equal(writes(), 1, `the live region is spoken once, when the warning comes, not on each of the 15 keys (written ${writes()} times)`);
  assert.ok(text(liveEl));
  assert.equal(unesc(p.el(described).innerHTML.replace(/<[^>]+>/g, '')).trim(), settingNumberWarning('role', '2nd shift sales'));
  for (const value of prefixes('2nd shift sales').reverse().slice(1)) type(value);
  type('');
  assert.equal(writes(), 2);
  assert.equal(text(liveEl), '');
});

// ---------- the example offered ----------
// The example is offered only when it is a plain way to write the value:
// a number with "#", "$", "%", a decimal point or another number at it gets
// none ("#one salesman", "Sales two.zero" are no help), a number word takes a
// capital where the words around it have one, and an example that would fail
// a check of its own ("One owner car specialist" says one owner) is not
// offered. A name loses only its digits, never a whole word.
test('numbers as words: a number with a sign, a decimal point or another number at it gets no word', () => {
  for (const value of ['#1 salesman', 'Sales 2.0', '0% APR specialist', '$0 down specialist', 'Team 2-3', 'shift 3:30']) {
    assert.equal(numbersAsWords(value), '', value);
  }
  assert.equal(numbersAsWords('Sales Associate 2'), 'Sales Associate Two', 'the last word takes the capital of the word before it');
  assert.equal(numbersAsWords('Internet Sales (Store 2)'), 'Internet Sales (Store Two)');
  assert.equal(numbersAsWords('sales associate 2'), 'sales associate two');
  assert.equal(numbersAsWords('Sales 2nd shift'), 'Sales second shift', 'the word after it decides when there is one');
  assert.equal(numbersAsWords('Shift 2.'), 'Shift Two.', 'a stop that ends the value is not a decimal point');
});

test('an example that would fail a check of its own is not offered, and a name loses only its digits', () => {
  const owner = '1 owner car specialist';
  assert.equal(numbersAsWords(owner), 'One owner car specialist');
  assert.equal(settingNumberWarning('role', owner), 'A number in your role ("1") keeps the Marketplace form shut for nearly every car: every number in a description must match the website\'s data for the car. Write the number as a word or leave it out.');
  const g = checked(ctxFor({ salesperson: { name: 'Sam', title: owner } })).g;
  assert.equal(g.problems.find((p) => p.code === 'setting-number').text, 'Your role "1 owner car specialist" has a number in it, and every number in a description must match the website\'s data for the car; change it in Settings (Your role): write the number as a word or leave it out');
  for (const value of ['#1 salesman', 'Sales 2.0', '0% APR specialist', '$0 down specialist']) {
    assert.ok(!/for example/.test(settingNumberWarning('role', value)), value);
  }
  assert.match(settingNumberWarning('role', 'Sales Associate 2'), /, for example "Sales Associate Two"\.$/);

  assert.equal(settingNumberWarning('name', 'J2 Smith'), 'A number in your name ("J2") keeps the Marketplace form shut for nearly every car: every number in a description must match the website\'s data for the car. Leave it out, for example "J Smith".');
  assert.match(settingNumberWarning('name', 'Sam2'), /, for example "Sam"\.$/);
  assert.match(settingNumberWarning('name', 'Sam 2nd'), /, for example "Sam"\.$/);
  assert.match(settingNumberWarning('name', 'Sam (2)'), /, for example "Sam"\.$/);
  const glued = checked(ctxFor({ salesperson: { name: 'J2 Smith', title: 'sales consultant' } })).g;
  assert.deepEqual(ruleProblems(glued).map((p) => p.text), ['Your name "J2 Smith" has a number in it, and every number in a description must match the website\'s data for the car; change it in Settings (Your name), for example to "J Smith"']);
  // every example offered passes the checks in the template
  for (const [setting, value] of [['role', 'Sales Associate 2'], ['role', 'Internet Sales (Store 2)'], ['name', 'J2 Smith'], ['name', 'Sam2']]) {
    const example = /for example "([^"]+)"/.exec(settingNumberWarning(setting, value))[1];
    const c = ctxFor({ salesperson: setting === 'role' ? { name: 'Sam', title: example } : { name: example, title: 'sales consultant' } });
    assert.deepEqual(checked(c).g.problems, [], example);
  }
});
