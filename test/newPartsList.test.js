// A new part a description claims must be one the website's own words say
// is new. In a draft, a list after "new" ("New tires, struts and brakes")
// was read only as far as "and": a part after a comma ("struts") was never
// checked. The list is now followed across commas, "and", "&", "/", "+" and
// "plus": each item that is a part on its own (maybe after "front", "rear",
// "front and rear", "front/rear", "the", "a", "both" or "new") is claimed
// too, and the list stops at anything else. After a comma, one of the car's
// own features as the website writes it ("Brake Assist") is that feature,
// and the list goes on past it. A part followed by words about its state
// ("inspected", "look great") is not claimed. The website's own words are
// read as before.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplateDescription, runGuardrails } from '../extension/src/rewriteTemplate.js';
import { runGuardrails as hostedGuardrails } from '../supabase/functions/_shared/guardrails.ts';
import { vehicle } from './helpers.js';

const FEATURES = ['Power Windows', 'Cruise Control', 'Backup Camera', 'Bluetooth', 'Keyless Entry', 'Tow Package', 'Navigation System', 'Heated Seats', 'Apple CarPlay'];
const EXAMPLE = { name: 'Example Motors', city: 'Springfield' };
const SAM = { name: 'Sam', title: 'sales consultant' };
// a car whose website says only that the tires are new
const car = (patch = {}) => ({
  ...vehicle('usedNormal', { features: FEATURES }), descriptionRaw: 'Local trade with new tires.', carfaxOneOwner: false,
  inventoryType: 'Used', readableType: 'Pre-Owned', urlConditionWord: 'used', siteTitle: 'Pre-Owned 2019 Ram 1500 Classic Express', ...patch,
});
const ctxOf = (v = car()) => ({ vehicle: v, dealer: EXAMPLE, salesperson: SAM, priceNote: '', price: v.price });
const PART = /^Says "(.*)", but the website says nothing about new or replaced parts for this car$/s;
// the new-part claims the checks find in the template with the sentence
// added; the hosted checker (supabase/functions/_shared/guardrails.ts) must
// find the same problems
const claimed = (sentence, c = ctxOf()) => {
  const text = `${buildTemplateDescription(c)}\n${sentence}`;
  const { problems } = runGuardrails(text, c);
  assert.deepEqual(JSON.parse(JSON.stringify(hostedGuardrails(text, c).problems)), JSON.parse(JSON.stringify(problems)), `the hosted checker says the same: ${sentence}`);
  return problems.map((p) => PART.exec(p.text)).filter(Boolean).map((m) => m[1]);
};

test('every part in a list after "new" is claimed, across commas, "and", "&", "/", "+" and "plus"', () => {
  for (const [sentence, claims] of [
    ['New tires, struts and brakes were replaced last month.', ['New tires, struts', 'New tires, struts and brakes']],
    ['New tires, brakes, rotors.', ['New tires, brakes', 'New tires, brakes, rotors']],
    ['New tires/brakes.', ['New tires/brakes']], ['New tires / brakes.', ['New tires / brakes']],
    ['New tires + brakes.', ['New tires + brakes']], ['New tires+brakes.', ['New tires+brakes']],
    ['New tires & brakes.', ['New tires & brakes']], ['New tires plus struts.', ['New tires plus struts']],
    ['New tires, struts, and front brakes.', ['New tires, struts', 'New tires, struts, and front brakes']],
    ['New tires, plus a battery.', ['New tires, plus a battery']],
    ['Brand new tires, battery & wipers.', ['Brand new tires, battery', 'Brand new tires, battery & wipers']],
  ]) {
    assert.deepEqual(claimed(sentence), claims, sentence);
  }
  // with nothing new on the website, the first part is claimed too
  assert.deepEqual(claimed('Fresh brakes, rotors and pads.', ctxOf(car({ descriptionRaw: '' }))), ['Fresh brakes', 'Fresh brakes, rotors', 'Fresh brakes, rotors and pads']);
  // the parts the website says are new pass, wherever the list puts them
  assert.deepEqual(claimed('New struts, tires and brakes.'), ['New struts', 'New struts, tires and brakes']);
});

test('a list item may have "front", "rear", "front and rear", "front/rear", "the", "a", "both" or "new" before its part', () => {
  for (const [sentence, claims] of [
    ['New tires, front and rear brakes.', ['New tires, front and rear brakes']], ['New tires, front/rear brakes.', ['New tires, front/rear brakes']],
    ['New tires, rear struts.', ['New tires, rear struts']], ['New tires, the battery and wipers.', ['New tires, the battery', 'New tires, the battery and wipers']],
    ['New tires, a battery.', ['New tires, a battery']], ['New tires, both front brakes.', ['New tires, both front brakes']],
    // an item that says "new" itself is quoted from its own "new"
    ['New tires and new brakes, plus a new battery.', ['new brakes', 'new battery']], ['New tires, new front and rear brakes.', ['new front and rear brakes']],
    // a part named in two part words ("brake pads") is one item, and the list goes on after it
    ['New tires, brake pads and rotors.', ['New tires, brake pads', 'New tires, brake pads and rotors']],
  ]) {
    assert.deepEqual(claimed(sentence), claims, sentence);
  }
  assert.deepEqual(claimed('New brake pads and rotors.', ctxOf(car({ descriptionRaw: 'Comes with new brake pads.' }))), ['New brake pads and rotors']);
});

test('the list stops at an item that is not a part on its own: a spec or brand word before it, or no part at all', () => {
  for (const sentence of [
    'New tires, HEMI engine, brakes.', 'New tires, automatic transmission and brakes.', 'New tires, Bosch wipers.', 'New tires, 8-speed transmission.',
    'New tires, oil change and brakes.', 'New arrival, tires and brakes to match.', 'New to our lot, brakes and tires look good.', 'New tires. Brakes and rotors too.',
    'New tires, remote start, brakes.',
  ]) {
    assert.deepEqual(claimed(sentence), [], sentence);
  }
});

test('a listed part followed by words about its state is not claimed; followed by a newness word, or anything else, it is', () => {
  for (const sentence of [
    'New tires, brakes inspected.', 'New tires, brakes were inspected.', 'New tires, brakes checked.', 'New tires, brakes have been serviced.', 'New tires, brakes look great.',
    'New tires, battery looks good.', 'New tires, brakes are good.', 'New tires, battery is good.', 'New tires, brakes in good shape.', 'New tires, brakes are in good shape.',
    'New tires, brakes original.', 'New tires, brakes are original.', 'New tires, original brakes.',
  ]) {
    assert.deepEqual(claimed(sentence), [], sentence);
  }
  for (const [sentence, claims] of [
    ['New tires, brakes were replaced.', ['New tires, brakes']], ['New tires, brakes are brand new.', ['New tires, brakes']], ['New tires, brakes are new too.', ['New tires, brakes']],
    ['New tires, brakes fresh.', ['New tires, brakes']], ['New tires, brakes installed last week.', ['New tires, brakes']], ['New tires, brakes put on in May.', ['New tires, brakes']],
    ['New tires, brakes done in May.', ['New tires, brakes']], ['New tires, brakes redone.', ['New tires, brakes']], ['New tires, brakes recently.', ['New tires, brakes']],
    ['New tires, brakes were just installed.', ['New tires, brakes']], ['New tires, struts and battery are all brand new.', ['New tires, struts', 'New tires, struts and battery']],
    // words that say nothing about its state leave it claimed
    ['New tires, brakes for winter.', ['New tires, brakes']],
  ]) {
    assert.deepEqual(claimed(sentence), claims, sentence);
  }
});

test('after a comma, one of the car\'s own features as the website writes it is that feature, and the list goes on past it', () => {
  const v = car({ features: [...FEATURES, 'New Tires', 'Brake Assist', 'Battery Saver', 'Wipers - Rain Sensing', 'Rear Wiper/Washer'], descriptionRaw: '' });
  const c = ctxOf(v);
  for (const [sentence, claims] of [
    ['New tires, Brake Assist, brakes.', ['New tires, Brake Assist, brakes']], ['New tires, brake assist.', []], ['New tires, Battery Saver, Bluetooth.', []],
    ['New tires, Wipers - Rain Sensing.', []], ['New tires, Rear Wiper/Washer and struts.', ['New tires, Rear Wiper/Washer and struts']],
    // after "and" or "&" it is a part, as before
    ['New tires and brake assist.', ['New tires and brake']], ['New tires & Brake Assist.', ['New tires & Brake']],
  ]) {
    assert.deepEqual(claimed(sentence, c), claims, sentence);
  }
});

test('the template passes its own checks with the website\'s features in its highlights line', () => {
  for (const features of [
    ['New Tires', 'Brake Assist', 'Battery Saver', 'Wipers - Rain Sensing'], ['New Tires', 'Front Brakes', 'Engine Immobilizer', 'ABS Brakes', 'Rear Wiper/Washer'],
    ['New Brake Pads & Rotors', 'Bluetooth', 'Backup Camera', 'Heated Seats'], ['New Tires/Brakes', 'Bluetooth', 'Brake Assist', 'Remote Start'],
    ['Backup Camera', 'New Battery', 'Battery Saver', 'Wipers - Intermittent'], ['NEW TIRES', 'BRAKE ASSIST', 'BATTERY SAVER', 'REAR WIPER'],
  ]) {
    for (const highlights of [null, features]) {
      const c = { ...ctxOf(car({ features, descriptionRaw: '' })), highlights };
      const text = buildTemplateDescription(c);
      assert.match(text, /Highlights: /, text);
      assert.deepEqual(runGuardrails(text, c).problems.filter((p) => !/^too-/.test(p.code)), [], `${features.join(' | ')}${highlights ? ' (picked)' : ''}`);
    }
  }
});

test('the website\'s own words are read as before: a list there backs each part joined by commas, "and", "&" or "plus"', () => {
  const c = ctxOf(car({ descriptionRaw: 'Recent service: new tires, brakes and rotors, plus new shocks. Comes with new struts & pads.' }));
  for (const sentence of ['New tires, brakes, rotors and shocks.', 'New struts and pads.', 'New rotors/brakes.']) assert.deepEqual(claimed(sentence, c), [], sentence);
  assert.deepEqual(claimed('New tires, brakes and a battery.', c), ['New tires, brakes and a battery']);
});

test('a list after "new" stops at a line break: the next line\'s first word is never read as part of the list', () => {
  // the website says the tires are new, so only a part the list goes on to is a claim
  const c = ctxOf(car({ descriptionRaw: 'Just put on new tires.' }));
  for (const sentence of [
    'It rides on new tires\nEngine and transmission run great.', 'Set of new tires\nBrakes, rotors and pads were inspected.',
    'Just put on new tires\nTransmission, engine and exhaust all strong.', 'New tires,\nbrakes and rotors were inspected.',
    '+ New tires\n+ Brakes', 'New tires /\nbrakes checked.',
  ]) {
    assert.deepEqual(claimed(sentence, c), [], JSON.stringify(sentence));
  }
  // a part after a comma is claimed when its line goes on with something else, not with words about its state
  assert.deepEqual(claimed('New tires, struts\nBrakes inspected at our shop.', c), ['New tires, struts']);
  // "and", "&" and "plus" join across a line break, as they did before the list was read
  assert.deepEqual(claimed('New tires\nand brakes.', c), ['New tires\nand brakes']);
});

test('"and", "&" and "plus" with spaces around them join across a line break on either side, and "front" or "rear" after them may end its line, as before the list was read', () => {
  const c = ctxOf(car({ descriptionRaw: 'Just put on new tires.' }));
  for (const [sentence, claims] of [
    ['This truck has new tires &\nbrakes.', ['new tires &\nbrakes']], ['New tires &\nbattery.', ['New tires &\nbattery']],
    ['New tires and front\nbrakes.', ['New tires and front\nbrakes']], ['New tires and rear\nshocks.', ['New tires and rear\nshocks']],
    ['New tires and\nfront\nbrakes.', ['New tires and\nfront\nbrakes']], ['New tires plus\nbrakes.', ['New tires plus\nbrakes']], ['New tires\n& brakes.', ['New tires\n& brakes']],
    ['New tires &\nfront\nbrakes &\nrear\nshocks.', ['New tires &\nfront\nbrakes', 'New tires &\nfront\nbrakes &\nrear\nshocks']],
  ]) {
    assert.deepEqual(claimed(sentence, c), claims, JSON.stringify(sentence));
  }
  // "+" and "/" never crossed a line break, nor did a word before the part other than "front" or "rear"
  for (const sentence of ['New tires +\nbrakes.', 'New tires /\nbrakes.', 'New tires and the\nbrakes.', 'New tires and front and rear\nbrakes.']) {
    assert.deepEqual(claimed(sentence, c), [], JSON.stringify(sentence));
  }
});

test('after a comma, a line break inside an item ends it: after "front" or "rear", between "brake" and "pads", before words about its state', () => {
  const c = ctxOf(car({ descriptionRaw: 'Just put on new tires.' }));
  assert.deepEqual(claimed('New tires, front\nbrakes.', c), []);
  assert.deepEqual(claimed('New tires, rear\nshocks are original.', c), []);
  assert.deepEqual(claimed('New tires, brake\npads.', c), ['New tires, brake']);
  assert.deepEqual(claimed('New tires, brakes\ninspected at our shop.', c), ['New tires, brakes']);
  assert.deepEqual(claimed('New tires, battery\nlooks good.', c), ['New tires, battery']);
});

test('a part is named in two words only when it is one part ("brake pads", "brake rotors"); two parts with nothing between them are no list', () => {
  const c = ctxOf(car({ descriptionRaw: 'Just put on new tires.' }));
  assert.deepEqual(claimed('New tires brakes and rotors.', c), []);
  assert.deepEqual(claimed('New battery tires and struts.', c), ['New battery']);
  assert.deepEqual(claimed('New brake rotors and pads.', c), ['New brake', 'New brake rotors and pads']);
  assert.deepEqual(claimed('New tires, brake rotors and struts.', c), ['New tires, brake rotors', 'New tires, brake rotors and struts']);
  assert.deepEqual(claimed('New tires, struts brakes and rotors.', c), ['New tires, struts']);
});

test('an item without its own "new" is quoted from the nearest "new" before it in the list, the claim or an item that says "new" itself', () => {
  const c = ctxOf(car({ descriptionRaw: 'Just put on new tires.' }));
  for (const [sentence, claims] of [
    ['New tires and new brakes, plus a battery.', ['new brakes', 'new brakes, plus a battery']],
    ['New tires, struts, new brakes and rotors.', ['New tires, struts', 'new brakes', 'new brakes and rotors']],
    ['New tires, brand new struts and wipers.', ['brand new struts', 'brand new struts and wipers']],
    ['New tires, the new battery and wipers.', ['new battery', 'new battery and wipers']],
    ['Fresh brakes, new battery, wipers.', ['Fresh brakes', 'new battery', 'new battery, wipers']],
  ]) {
    assert.deepEqual(claimed(sentence, c), claims, sentence);
  }
});

test('a very long list after "new" is read in a moment, with the same problems as before', () => {
  const FEATURED = [...FEATURES, 'Brake Assist', 'New Tires/Brakes'];
  const unsaid = (text) => `Says "${text}", but the website says nothing about new or replaced parts for this car`;
  const rest = (words) => [{ code: 'too-long', text: `${words} words; the limit is 120` }, { code: 'no-vin', text: 'Doesn\'t include the VIN' }];
  const unsigned = [{ code: 'no-dealer', text: 'Doesn\'t name Example Motors' }, { code: 'no-role', text: 'Doesn\'t give your role ("sales consultant"); the sign-off says it' }];
  for (const [text, c, expected] of [
    ['new tires, '.repeat(4000), ctxOf(car({ descriptionRaw: '' })), [...rest(8000), { code: 'unsupported-claim', text: unsaid('new tires') }, ...unsigned]],
    ['new tires, struts, '.repeat(2000), ctxOf(car({ descriptionRaw: '' })), [...rest(6000), { code: 'unsupported-claim', text: unsaid('new tires') }, { code: 'unsupported-claim', text: unsaid('new tires, struts') }, ...unsigned]],
    ['New tires, Brake Assist, brakes, '.repeat(1500), ctxOf(car({ descriptionRaw: '', features: FEATURED })), [...rest(7500), { code: 'unsupported-claim', text: unsaid('New tires, Brake Assist, brakes') }, ...unsigned]],
  ]) {
    for (const check of [runGuardrails, hostedGuardrails]) {
      const started = Date.now();
      const { problems } = check(text, c);
      const took = Date.now() - started;
      assert.deepEqual(JSON.parse(JSON.stringify(problems)), expected, text.slice(0, 40));
      assert.ok(took < 2000, `${text.slice(0, 40)}: ${took} ms`);
    }
  }
});
