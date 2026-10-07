// The dealership's price note goes into every description whole, and may end
// the sentence that says where the fees go with "not the dealer" ("Plus tax,
// title and registration, which go to the state, not the dealer."). That
// rule read only the sentence before the phrase, so the rest of the note
// could still carry a steer with no "I", "me" or "my" in it ("Tax, title and
// fees go to the state, not the dealer. Text Sam at 555-123-4567."). A note
// that says "not the dealer", "not the dealership" or their plurals now
// passes only when every word of it is price and fee wording
// (PRICE_NOTE_WORDS) or a word of the dealership's own name, city or state,
// and its only digits are dollar amounts and percentages. A note without
// those phrases is read as before. Set-up and Settings show the same reason
// under the price note while it is typed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplateDescription, runGuardrails, checkClosingLine, usableClosingLine, PRICE_NOTE_WORDS, priceNoteWarning, priceNoteNotice } from '../extension/src/rewriteTemplate.js';
import { PRICE_NOTE_WORDS as TS_WORDS } from '../supabase/functions/_shared/guardrails.ts';
import { vehicle } from './helpers.js';

const FEATURES = ['Power Windows', 'Cruise Control', 'Backup Camera', 'Bluetooth', 'Keyless Entry', 'Tow Package', 'Navigation System', 'Heated Seats', 'Apple CarPlay'];
const EXAMPLE = { name: 'Example Motors', city: 'Springfield', state: 'OH', zip: '43215' };
const SAM = { name: 'Sam', title: 'sales consultant' };
// a car whose website shows one price, so a fee amount in a note is not held to a gap between two
const ONE_PRICE = () => ({ ...vehicle('usedNormal', { features: FEATURES }), priceBeforeFees: null });
const withNote = (priceNote, dealer = EXAMPLE) => {
  const v = ONE_PRICE();
  return { vehicle: v, dealer, salesperson: SAM, priceNote, price: v.price };
};
const problems = (c) => runGuardrails(buildTemplateDescription(c), c).problems;
const REASON = (out, phrase = 'not the dealer') => `Your price note says "${phrase}", so it may only say where the fees go and what the price includes; take out ${out}, or take out "${phrase}". Change the note in Settings.`;
const PLACE_REASON = (phrase = 'not the dealer') => `Your dealership's price note says "${phrase}"; change the note in Settings`;
const FEES = 'Tax, title and fees go to the state, not the dealer.';

test('realistic price notes that say "not the dealer" pass, and the template carries them whole', () => {
  for (const note of [
    'Plus tax, title and registration, which go to the state, not the dealer.',
    'Price excludes tax, title and a $499 documentation fee. Tax and title fees go to the state, not the dealer.',
    'All prices plus tax, title and tags. Tax, title and tag fees go to the state, not the dealer.',
    'Price excludes tax, title and registration, which go to the state, not the dealer. Doc fee of $399 goes to the dealer.',
    // the dealership's own name, city and state, as set
    'Example Motors prices plus tax, title and tags. Tax, title and tag fees go to the state, not the dealer.',
    'All Example Motors prices plus tax, title and registration. Tax and registration fees are paid to the state, not the dealership.',
    'Price excludes OH sales tax. Tax and title fees go to the state, not the dealer.',
    'Price excludes Springfield city tax and county fees. Tax and fees go to the city and county, not the dealer.',
    // the suggested wording, with where the fees go after it
    'Price is before the $490 doc fee. Tax and tags go to the state, not the dealer.',
    'Price includes the $499 doc fee. Tax, title and tags are paid to the county, not the dealership.',
    'Advertised price excludes sales tax, title and registration, which are paid directly to the DMV, not the dealer.',
    'Internet price plus tax, title and license. Tax, title and license fees go to the state, not the dealers.',
    'Prices exclude tax, title, registration and a $499 electronic filing fee. Tax and title fees are collected for the state and county, not the dealer.',
    'Price does not include tax, title or registration fees, which go to the Secretary of State, not the dealership.',
    'Plus applicable sales tax of 6% and title fees, which go to the state, not the dealer.',
    'Rebates and incentives may vary. Tax, title and tags are paid to the state, not the dealer.',
    'Price subject to credit approval for qualified buyers. Tax and title fees go to the state, not the dealer.',
    'Price after rebates. A $1,299.00 dealer fee applies. Tax and tags go to the state, not the dealerships.',
    'plus tax and tags, which go to the state, not the dealer.',
  ]) {
    const c = withNote(note);
    const text = buildTemplateDescription(c);
    assert.ok(text.includes(note), note);
    assert.deepEqual(runGuardrails(text, c).problems, [], note);
    assert.equal(priceNoteWarning(note, EXAMPLE), '', `no warning: ${note}`);
  }
});

test('a "not the dealer" note with any word that is not price and fee wording is refused, and the reason quotes those words', () => {
  for (const [extra, out] of [
    ['Text Sam at 555-123-4567.', '"Text", "Sam" and "555-123-4567"'],
    // the money or the deal sent to someone by name, or a way to pay or meet past the dealership
    ['Payment goes to Sam.', '"Payment" and "Sam"'], ['The price goes to Sam.', '"Sam"'], ['Price is paid to Sam in cash.', '"Sam"'],
    ['Best price from Sam.', '"Best" and "Sam"'], ['Sam has the best price.', '"Sam", "has" and "best"'], ['Financing through Sam.', '"Sam"'],
    ['Price negotiable face to face.', '"negotiable" and "face"'], ['Price negotiable in person.', '"negotiable" and "person"'],
    ['Price is better in private.', '"better" and "private"'], ['Cash price available privately.', '"available" and "privately"'],
    ['Payment via Venmo.', '"Payment", "via" and "Venmo"'], ['Price by Zelle or Venmo.', '"Zelle" and "Venmo"'], ['Cash App or PayPal accepted.', '"App", "PayPal" and "accepted"'],
    ["Pay at Sam's office.", '"Pay" and "Sam\'s"'],
    // the first person, the salesperson by any title, a way to get in touch, a deal made past the dealership
    ['Ask for me.', '"Ask" and "me"'], ['We handle the paperwork.', '"We", "handle" and "paperwork"'], ['Text us.', '"Text" and "us"'],
    ['Deal direct with the salesperson.', '"Deal", "direct" and "salesperson"'], ['Message the poster.', '"Message" and "poster"'],
    ['DM for the best price.', '"DM" and "best"'], ['Buy privately and save.', '"Buy", "privately" and "save"'], ['In person only.', '"person"'],
    ['Ask for the 2nd shift salesperson.', '"Ask", "2nd", "shift" and "salesperson"'],
    // an address, a link, a phone number written any way, a symbol
    ['Email sales@carmail.com.', '"Email", "@", "carmail" and "com"'], ['See https://carmail.com/deals', '"See", "https", "carmail", "com" and "deals"'],
    ['555-123-4567.', '"555-123-4567"'], ['Call (555) 123-4567.', '"Call", "555" and "123-4567"'], ['Call 5551234567.', '"Call" and "5551234567"'],
    ['５５５-１２３-４５６７.', '"555-123-4567"'], ['\u{1F4DE}', '"\u{1F4DE}"'],
    // a year or a number that is not a dollar amount or a percentage
    ['Prices valid through 2026.', '"valid" and "2026"'], ['Tax is $5551234567.', '"$5551234567"'],
    // a look-alike letter makes a word that is not on the list ("Text" with a Cyrillic "e", "price" with a Cyrillic "e")
    ['Tеxt Sam.', '"Tеxt" and "Sam"'], ['Pricе is final.', '"Pricе" and "final"'],
  ]) {
    const note = `${FEES} ${extra}`;
    const c = withNote(note);
    const text = buildTemplateDescription(c);
    assert.ok(text.includes(note), extra);
    assert.deepEqual(runGuardrails(text, c).problems, [{ code: 'banned-phrase', text: REASON(out) }], extra);
  }
});

test('before the fee sentence, inside it or after ";" the same: every word of the whole note is read', () => {
  for (const [note, out] of [
    ['Deal direct with the salesperson. Tax, title and fees go to the state, not the dealer.', '"Deal", "direct" and "salesperson"'],
    ['Tax, title and fees, which buyers who deal direct never pay twice, go to the state, not the dealer.', '"who", "deal", "direct", "never", "pay" and "twice"'],
    ['Tax, title and fees go to the state, not the dealer; contact the salesperson directly.', '"contact" and "salesperson"'],
    ['Fees go to the state, not the dealer; buyers can deal directly with the seller.', '"can", "deal" and "seller"'],
    ['Tax, title and fees go to the state, not the dealer, and are due at signing.', '"signing"'],
    ['Ask for Sam, not the dealer\'s front desk. Tax and tags extra.', '"Ask", "Sam", "dealer\'s", "front" and "desk"'],
    ['Tax, title and fees go to the state, not the dealership. Text Sam.', '"Text" and "Sam"'],
  ]) {
    const phrase = /not the dealership/.test(note) ? 'not the dealership' : 'not the dealer';
    assert.deepEqual(problems(withNote(note)), [{ code: 'banned-phrase', text: REASON(out, phrase) }], note);
  }
});

test('the dealership\'s own name, city and state pass only for that dealership', () => {
  const note = 'Example Motors prices plus tax and tags. Tax and tags go to the Springfield county tax office, not the dealer. OH sales tax applies.';
  const sample = { name: 'Sample Auto', city: 'Shelbyville', state: 'IL', zip: '62565' };
  // (the Springfield county tax office is no fee place the sentence rule knows, so the place is said in a sentence of its own)
  const own = 'Example Motors prices plus tax and tags. Tax and tags go to the county, not the dealer. Springfield and OH sales tax apply.';
  assert.deepEqual(problems(withNote(own)), []);
  assert.deepEqual(problems(withNote(own, sample)), [{ code: 'banned-phrase', text: REASON('"Example", "Motors", "Springfield" and "OH"') }]);
  // with no dealership set, none of them pass
  assert.equal(priceNoteWarning(own, {}), REASON('"Example", "Motors", "Springfield" and "OH"'));
  assert.equal(priceNoteWarning(own), REASON('"Example", "Motors", "Springfield" and "OH"'));
  assert.equal(priceNoteWarning(own, EXAMPLE), '');
  // the sentence rule still decides where the fees may go: a place it does not know is refused as before
  assert.deepEqual(problems(withNote(note)), [{ code: 'banned-phrase', text: PLACE_REASON() }]);
});

test('dollar amounts and percentages pass; any other digits are refused', () => {
  for (const extra of ['The $499 doc fee is extra.', 'A $1,299.00 dealer fee applies.', 'Sales tax of 6% applies.', 'A 6.25 % sales tax applies.', 'A $ 499 doc fee applies.']) {
    assert.deepEqual(problems(withNote(`${FEES} ${extra}`)), [], extra);
  }
  for (const [extra, out] of [
    ['2nd shift prices.', '"2nd" and "shift"'], ['Doc fee $499 #2.', '"#2"'], ['Tax is $1,2345.', '"$1,2345"'], ['Tax 6.25.', '"6.25"'], ['Fees 24/7.', '"24/7"'],
  ]) {
    assert.deepEqual(problems(withNote(`${FEES} ${extra}`)), [{ code: 'banned-phrase', text: REASON(out) }], extra);
  }
});

test('the sentence rule still comes first: "not the dealer" that does not end where the fees go is refused as before', () => {
  for (const note of ['Not the dealer: tax and fees go to the state.', 'Text Sam, not the dealer.', 'Deal direct with me: fees go to the state, not the dealer.', 'Taxes go to the state, not the dealer; text me.']) {
    assert.deepEqual(problems(withNote(note)), [{ code: 'banned-phrase', text: PLACE_REASON() }], note);
    assert.equal(priceNoteWarning(note, EXAMPLE), PLACE_REASON(), note);
  }
});

test('"not the dealers" and "not the dealerships" are banned like "not the dealer": in descriptions, closing lines and the price note', () => {
  const plain = withNote('');
  const template = buildTemplateDescription(plain);
  for (const [line, phrase] of [['Buy from me, not the dealers.', 'not the dealers'], ['Text me, not the dealerships.', 'not the dealerships']]) {
    assert.deepEqual(runGuardrails(`${template}\n${line}`, plain).problems.map((p) => p.text), [`Says "${phrase}"`], line);
    assert.deepEqual(checkClosingLine(line).problems.filter((p) => p.code === 'closing-banned'), [{ code: 'closing-banned', text: `The closing line says "${phrase}"` }], line);
    assert.equal(usableClosingLine(line), '', line);
    // as the whole price note: no sentence about where the fees go before it
    assert.deepEqual(problems(withNote(line)), [{ code: 'banned-phrase', text: PLACE_REASON(phrase) }], line);
  }
  assert.deepEqual(problems(withNote('Tax, title and fees go to the state, not the dealers. Text Sam.')), [{ code: 'banned-phrase', text: REASON('"Text" and "Sam"', 'not the dealers') }]);
  assert.deepEqual(problems(withNote('Tax, title and fees go to the state, not the dealerships.')), []);
  // beside the note, the description's own words are refused as before
  const c = withNote('Tax, title and fees go to the state, not the dealers.');
  assert.deepEqual(runGuardrails(`${buildTemplateDescription(c)}\nTaxes go to the state, not the dealers.`, c).problems.map((p) => p.text), ['Says "not the dealers"']);
});

test('a price note without "not the dealer" is read as before: ordinary disclaimers pass and its words are not held to the list', () => {
  for (const note of [
    'Neither the manufacturer nor the dealer is responsible for pricing errors.', 'Price valid at this location only, not at our sister stores.',
    'Price is without dealer fees; tax and tags extra.', 'Price includes the $490 doc fee; tax and tags extra.', 'Tax and tags extra.',
    'Plus tax, title and registration, which go to the state.', 'Not responsible for typographical errors. Tax and tags extra.',
  ]) {
    assert.deepEqual(problems(withNote(note)), [], note);
    assert.equal(priceNoteWarning(note, EXAMPLE), '', note);
  }
});

test('the list is closed: no pronoun, person, role, way to get in touch, payment route or negotiation word, and both checkers hold the same one', () => {
  assert.ok(Object.isFrozen(PRICE_NOTE_WORDS));
  assert.deepEqual([...TS_WORDS], [...PRICE_NOTE_WORDS], 'the hosted checker lists the same words');
  assert.equal(new Set(PRICE_NOTE_WORDS).size, PRICE_NOTE_WORDS.length, 'each word once');
  for (const w of PRICE_NOTE_WORDS) assert.match(w, /^\p{Ll}+$/u, w);
  for (const w of ['i', 'me', 'my', 'we', 'us', 'you', 'he', 'she', 'him', 'her', 'they', 'them', 'it', 'sam', 'salesperson', 'seller', 'owner', 'manager', 'advisor', 'text', 'call', 'email', 'message', 'contact', 'phone', 'dm', 'venmo', 'zelle', 'paypal', 'person', 'private', 'privately', 'face', 'negotiable', 'deal', 'best', 'direct', 'buy', 'save', 'offer', 'lot', 'store', 'home', 'via', 's', 't']) {
    assert.ok(!PRICE_NOTE_WORDS.includes(w), `"${w}" is not on the list`);
  }
  for (const w of ['price', 'tax', 'title', 'registration', 'fees', 'go', 'to', 'the', 'state', 'not', 'dealer', 'dealership', 'dealers', 'dealerships', 'dmv', 'secretary', 'before', 'exclude']) {
    assert.ok(PRICE_NOTE_WORDS.includes(w), `"${w}" is on the list`);
  }
});

test('the warning set-up and Settings show under the price note is the reason the checks give, and the notice beside it leaves out the quoted words', () => {
  const steer = `${FEES} Text Sam at 555-123-4567.`;
  assert.equal(priceNoteWarning(steer, EXAMPLE), REASON('"Text", "Sam" and "555-123-4567"'));
  assert.equal(priceNoteWarning(steer, EXAMPLE), problems(withNote(steer))[0].text);
  const notice = 'Your price note says "not the dealer", so it may only say where the fees go and what the price includes. Take out the other words, or take out "not the dealer".';
  assert.equal(priceNoteNotice(steer, EXAMPLE), notice);
  // the notice stays the same while the quoted words change, so a live region written with it is spoken once
  assert.equal(priceNoteNotice(`${FEES} Text Sam.`, EXAMPLE), notice);
  assert.equal(priceNoteNotice(FEES, EXAMPLE), '');
  assert.equal(priceNoteNotice('Tax and tags extra.', EXAMPLE), '');
  assert.equal(priceNoteNotice('Text Sam, not the dealer.', EXAMPLE), PLACE_REASON());
  assert.equal(priceNoteWarning('', EXAMPLE), '');
  assert.equal(priceNoteWarning(undefined), '');
});

// ---------- set-up's price step and Settings' price note field ----------
import { wiz, wizardHtml, handleWizardInput, handleWizardChange } from '../extension/wizard.js';
import { withDefaults } from '../extension/src/settings.js';
import { loadPopup, POPUP_ORIGIN } from './popupHarness.js';
import { siteKeys } from '../extension/src/storageKeys.js';
import { MY_STORE } from './helpers.js';

const unesc = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
const inputWith = (html, attr) => (new RegExp(`<input\\b[^>]*\\s${attr}[^>]*>`).exec(html) || [''])[0];
const region = (html, id) => {
  const m = new RegExp(`<div id="${id}">(.*?)</div>(?=\\s*(?:<|$))`, 's').exec(html);
  return m ? unesc(m[1].replace(/<[^>]+>/g, '')) : null;
};
const liveRegion = (html, id) => {
  const m = new RegExp(`<div id="${id}" class="sr" aria-live="polite">(.*?)</div>`, 's').exec(html);
  return m ? unesc(m[1]) : null;
};
// an element that counts the writes to it, as a screen reader would speak each write to a live region
function countingElement(id) {
  let html = '';
  const el = { id, writes: 0 };
  Object.defineProperty(el, 'innerHTML', { get: () => html, set: (v) => { html = String(v); el.writes += 1; }, configurable: true });
  Object.defineProperty(el, 'textContent', { get: () => unesc(html.replace(/<[^>]+>/g, '')), set: (v) => { html = String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); el.writes += 1; }, configurable: true });
  return el;
}
const prefixes = (value) => [...value].map((_, i) => value.slice(0, i + 1));

test('set-up\'s price step warns under the price note while it steers, and as the person types; the live region is spoken once', () => {
  wiz.active = true;
  wiz.step = 'price';
  wiz.settings = withDefaults({ salesperson: SAM, dealer: EXAMPLE, priceNote: `${FEES} Text Sam.` });
  let html = wizardHtml();
  assert.match(inputWith(html, 'id="wizPriceNote"'), /aria-describedby="wizPriceNoteWarn wizPriceHint"/, 'the note is described by its warning and its hint');
  assert.equal(region(html, 'wizPriceNoteWarn'), REASON('"Text" and "Sam"'));
  assert.equal(liveRegion(html, 'wizPriceNoteSay'), priceNoteNotice(`${FEES} Text Sam.`, EXAMPLE));
  wiz.settings = withDefaults({ salesperson: SAM, dealer: EXAMPLE, priceNote: FEES });
  html = wizardHtml();
  assert.equal(region(html, 'wizPriceNoteWarn'), '');
  assert.equal(liveRegion(html, 'wizPriceNoteSay'), '');

  const elements = new Map();
  globalThis.document = { getElementById: (id) => { if (!elements.has(id)) elements.set(id, countingElement(id)); return elements.get(id); } };
  const say = document.getElementById('wizPriceNoteSay');
  for (const value of prefixes(`${FEES} Text Sam at 555-123-4567.`)) handleWizardInput({ id: 'wizPriceNote', value });
  assert.equal(document.getElementById('wizPriceNoteWarn').textContent, REASON('"Text", "Sam" and "555-123-4567"'), 'the warning follows the typing');
  assert.equal(say.writes, 1, `the live region is written once, when the warning comes (written ${say.writes} times)`);
  handleWizardInput({ id: 'wizPriceNote', value: FEES });
  assert.equal(document.getElementById('wizPriceNoteWarn').textContent, '');
  assert.equal(say.writes, 2);
  // the warning never holds the note back: the step keeps it as typed
  handleWizardChange({ id: 'wizPriceNote', value: `${FEES} Text Sam.` });
  assert.equal(wiz.settings.priceNote, `${FEES} Text Sam.`);
  wiz.active = false;
});

test('Settings warns under the price note while it steers, and the warning follows the typing and the dealership name', async () => {
  const k = siteKeys(POPUP_ORIGIN);
  const steer = 'Example Motors prices plus tax. Tax and fees go to the state, not the dealer. Text Sam.';
  const p = await loadPopup({ local: { [k.settings]: { ...MY_STORE, salesperson: SAM, dealer: EXAMPLE, priceNote: steer } } });
  await p.tab('settings');
  const html = p.panel();
  assert.match(inputWith(html, 'name="priceNote"'), /aria-describedby="priceNoteWarn priceNoteHint"/);
  assert.equal(region(html, 'priceNoteWarn'), REASON('"Text" and "Sam"'));
  assert.equal(liveRegion(html, 'priceNoteSay'), priceNoteNotice(steer, EXAMPLE));

  const type = (name, value) => p.el('panel').listeners.input({ target: { name, value } });
  type('priceNote', 'Example Motors prices plus tax. Tax and fees go to the state, not the dealer.');
  assert.equal(p.el('priceNoteWarn').innerHTML, '');
  assert.equal(p.el('priceNoteSay').textContent, '');
  type('priceNote', steer);
  assert.equal(unesc(p.el('priceNoteWarn').innerHTML.replace(/<[^>]+>/g, '')), REASON('"Text" and "Sam"'));
  // the dealership's name as the form holds it now: another name no longer covers "Example Motors"
  type('dealerName', 'Sample Auto');
  assert.equal(unesc(p.el('priceNoteWarn').innerHTML.replace(/<[^>]+>/g, '')), REASON('"Example", "Motors", "Text" and "Sam"'));
});
