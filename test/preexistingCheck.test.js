// The "another vehicle" check in fillFormInPage (facebook/fillForm.js), run
// after Lot Current's own fill: what the form shows for a field Lot Current
// filled is ours, whichever label of a choice it shows and however a number is
// grouped. A value of another car is not ours. The check runs inside the page,
// so it is compiled here from the fill code's source with its own norm and accepted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FORM_MAP } from '../extension/facebook/formMap.js';

const src = readFileSync(new URL('../extension/facebook/fillForm.js', import.meta.url), 'utf8');
function innerLine(name) {
  const m = src.match(new RegExp(`\\n  const ${name} = .*;\\n`));
  assert.ok(m, `${name} is defined in fillFormInPage`);
  return m[0].trim();
}
function innerFunction(name) {
  const start = src.search(new RegExp(`\\n  function ${name}\\(`));
  assert.ok(start >= 0, `${name} is defined in fillFormInPage`);
  const end = src.indexOf('\n  }\n', start);
  return src.slice(start + 1, end + 4);
}
const shownAsOurs = new Function(`${innerLine('norm')}\n${innerLine('accepted')}\n${innerFunction('shownAsOurs')}\nreturn shownAsOurs;`)();
const field = (key) => FORM_MAP.fields.find((f) => f.key === key);

test('a choice field shows our value under one of its labels: Car/Truck is the stored car_truck', () => {
  const vehicleType = field('vehicleType');
  assert.equal(shownAsOurs('Car/Truck', 'car_truck', vehicleType), true);
  assert.equal(shownAsOurs('Car or truck', 'car_truck', vehicleType), true);
  assert.equal(shownAsOurs('Gas', 'Gasoline', field('fuelType')), true, 'the form may say Gas for Gasoline');
  assert.equal(shownAsOurs('Off-white', 'Off white', field('exteriorColor')), true);
});

test('a number Facebook groups with separators is ours: 28,995 is the stored 28995', () => {
  assert.equal(shownAsOurs('28,995', '28995', field('price')), true);
  assert.equal(shownAsOurs('$28,995', '28995', field('price')), true);
});

test('another car\'s value is not ours', () => {
  assert.equal(shownAsOurs('Motorcycle', 'car_truck', field('vehicleType')), false);
  assert.equal(shownAsOurs('28,996', '28995', field('price')), false);
  assert.equal(shownAsOurs('Gray', 'Off white', field('exteriorColor')), false);
});

test('nothing stored is never ours, so any value the form shows is reported', () => {
  assert.equal(shownAsOurs('Car/Truck', '', field('vehicleType')), false);
});
