import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl } from '../extension/facebook/detectPost.js';
import { FORM_MAP } from '../extension/facebook/formMap.js';

test('a listing address means it posted; the "your listings" page probably does; anything else is nothing', () => {
  assert.deepEqual(classifyUrl('https://www.facebook.com/marketplace/item/1234567890/', FORM_MAP), { status: 'listing', url: 'https://www.facebook.com/marketplace/item/1234567890/', id: '1234567890' });
  assert.equal(classifyUrl('https://www.facebook.com/marketplace/item/123?ref=share', FORM_MAP).status, 'listing');
  assert.equal(classifyUrl('https://www.facebook.com/marketplace/you/selling', FORM_MAP).status, 'probably');
  assert.equal(classifyUrl('https://www.facebook.com/marketplace/selling/', FORM_MAP).status, 'probably');
  assert.equal(classifyUrl(FORM_MAP.createUrl, FORM_MAP), null);
  assert.equal(classifyUrl('https://www.facebook.com/marketplace/', FORM_MAP), null);
  assert.equal(classifyUrl('', FORM_MAP), null);
  assert.equal(classifyUrl(undefined, FORM_MAP), null);
});

test('the form map only ever points at the create page and reads addresses; it has no verified claim', () => {
  assert.equal(FORM_MAP.createUrl, 'https://www.facebook.com/marketplace/create/vehicle');
  assert.notEqual(FORM_MAP.verifiedAgainstFacebook, true, 'never claim the live form is fully verified');
  assert.ok(FORM_MAP.fields.every((f) => Array.isArray(f.name) && f.name.length && f.key && f.label && f.kind));
  assert.deepEqual(FORM_MAP.neverFill.map((f) => f.key), ['condition', 'titleStatus']);
});
