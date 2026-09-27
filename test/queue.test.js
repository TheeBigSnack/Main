import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, currentVin, advance, pause, resume, summary, describe } from '../extension/src/queue.js';

const VINS = ['1C6RR7FT0KS643289', '1C4SJVDT7NS142834', '2C3CDZC96GH308445'];

test('a queue is made from the picked cars, de-duplicated, and capped by the day\'s remaining posts', () => {
  const r = createQueue([...VINS, VINS[0], ' 1c6rr7ft0ks643289 '], { remaining: 10, dealerTabId: 7, now: 'T' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.queue.vins, VINS);
  assert.equal(r.dropped, 0);
  assert.deepEqual({ index: r.queue.index, status: r.queue.status, dealerTabId: r.queue.dealerTabId, startedAt: r.queue.startedAt }, { index: 0, status: 'running', dealerTabId: 7, startedAt: 'T' });

  const capped = createQueue(VINS, { remaining: 2 });
  assert.deepEqual(capped.queue.vins, VINS.slice(0, 2));
  assert.equal(capped.dropped, 1);

  assert.equal(createQueue([], { remaining: 5 }).ok, false);
  const full = createQueue(VINS, { remaining: 0 });
  assert.equal(full.ok, false);
  assert.match(full.error, /daily post cap/);
});

test('walking the queue: outcomes are recorded, the position moves, and it ends by itself', () => {
  let q = createQueue(VINS, { remaining: 10 }).queue;
  assert.equal(currentVin(q), VINS[0]);
  q = advance(q, 'posted');
  assert.equal(currentVin(q), VINS[1]);
  q = advance(q, 'draft');
  q = advance(q, 'nonsense'); // unknown outcomes count as skipped
  assert.equal(q.status, 'done');
  assert.equal(currentVin(q), null);
  assert.deepEqual(q.results, { [VINS[0]]: 'posted', [VINS[1]]: 'draft', [VINS[2]]: 'skipped' });
  assert.equal(advance(q, 'posted'), q, 'a finished queue does not move');
  assert.deepEqual(summary(q), { total: 3, done: 3, remaining: 0, position: 3, status: 'done', posted: 1, draft: 1, skipped: 1, blocked: 0 });
  assert.equal(describe(q), 'Queue finished: 3 cars · 1 posted, 1 saved as draft, 1 skipped');
});

test('pause keeps the place; resume carries on', () => {
  let q = createQueue(VINS, { remaining: 10 }).queue;
  q = advance(q, 'posted');
  q = pause(q);
  assert.equal(q.status, 'paused');
  assert.equal(currentVin(q), VINS[1]);
  assert.equal(describe(q), 'Car 2 of 3 (paused) · 1 posted');
  q = advance(q, 'skipped'); // a car can still be skipped while paused
  assert.equal(q.status, 'paused');
  q = resume(q);
  assert.equal(q.status, 'running');
  assert.equal(currentVin(q), VINS[2]);
  assert.equal(pause(null), null);
  assert.equal(summary(null).total, 0);
  assert.equal(describe(null), '');
});
