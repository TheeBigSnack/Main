import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usablePhotos, defaultPick, settlePick, togglePhoto, makeCover, pickSummary } from '../extension/src/photoPick.js';

const P = (n) => `https://img.example-dealer.test/car/${n}.jpg`;
const PHOTOS = [P(1), P(2), P(3), P(4), P(5)];

test('only the website\'s own photos can be picked: each once, http(s) only, never from Facebook\'s servers', () => {
  const list = [P(1), P(1), 'data:image/png;base64,AAAA', 'javascript:alert(1)', 42, null, 'https://scontent.xx.fbcdn.net/v/1.jpg', 'https://www.facebook.com/photo.jpg', P(2)];
  assert.deepEqual(usablePhotos(list), [P(1), P(2)]);
  assert.deepEqual(usablePhotos(undefined), []);
});

test('no pick made: the website\'s first photos, up to the form\'s limit', () => {
  assert.deepEqual(defaultPick(PHOTOS, 3), [P(1), P(2), P(3)]);
  assert.deepEqual(settlePick(null, PHOTOS, 3), [P(1), P(2), P(3)]);
  assert.deepEqual(settlePick(undefined, PHOTOS, 20), PHOTOS);
  assert.deepEqual(defaultPick(PHOTOS, 0), PHOTOS, 'an unknown limit cuts nothing');
});

test('a pick keeps its order and loses photos the website no longer shows', () => {
  // picked before the post-time re-fetch; the website then dropped photo 4
  const pick = [P(4), P(2), P(2), 'https://elsewhere.test/x.jpg', P(1)];
  assert.deepEqual(settlePick(pick, [P(1), P(2), P(3)], 20), [P(2), P(1)]);
  assert.deepEqual(settlePick([P(5), P(4), P(3)], PHOTOS, 2), [P(5), P(4)], 'cut to the limit');
  assert.deepEqual(settlePick([], PHOTOS, 20), [], 'an empty pick stays empty: the person unticked everything');
});

test('ticking adds at the end, unticking removes, and a tick past the limit is refused', () => {
  let r = togglePhoto(null, P(2), PHOTOS, 3);
  assert.deepEqual(r, { pick: [P(1), P(3)], full: false }, 'unticks one of the default three');
  r = togglePhoto(r.pick, P(5), PHOTOS, 3);
  assert.deepEqual(r, { pick: [P(1), P(3), P(5)], full: false });
  r = togglePhoto(r.pick, P(4), PHOTOS, 3);
  assert.deepEqual(r, { pick: [P(1), P(3), P(5)], full: true });
  assert.deepEqual(togglePhoto([P(1)], 'https://elsewhere.test/x.jpg', PHOTOS, 3), { pick: [P(1)], full: false }, 'a photo the website does not show is never added');
});

test('make cover moves a photo to the front, ticking it, and makes room at the limit', () => {
  assert.deepEqual(makeCover(null, P(3), PHOTOS, 20), [P(3), P(1), P(2), P(4), P(5)]);
  assert.deepEqual(makeCover([P(1), P(2)], P(5), PHOTOS, 2), [P(5), P(1)]);
  assert.deepEqual(makeCover([P(1)], 'https://elsewhere.test/x.jpg', PHOTOS, 2), [P(1)]);
});

test('the summary says how many are picked, the limit when it bites, and that one is needed', () => {
  assert.equal(pickSummary(null, PHOTOS, 20), '5 of 5 photos picked.');
  assert.equal(pickSummary(null, PHOTOS, 3), '3 of 5 photos picked; the form takes 3.');
  assert.equal(pickSummary([P(2)], PHOTOS, 3), '1 of 5 photos picked.');
  assert.match(pickSummary([], PHOTOS, 3), /needs at least one/);
  assert.match(pickSummary(null, [], 3), /no photos/);
});
