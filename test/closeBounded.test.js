// The browser flows close their context in a finally block. Playwright waits for
// the browser process to exit with no timer of its own, so one that never exits
// would hold the run (and its memory) forever (HANDOFF 26.4). closeBounded
// (test/e2e/closeBounded.mjs) bounds that wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeBounded } from './e2e/closeBounded.mjs';

test('a browser context that closes is reported closed; one that never exits is reported not closed once the wait runs out', async () => {
  assert.equal(await closeBounded({ close: async () => {} }, 1000), true, 'a browser that closes');
  assert.equal(await closeBounded({ close: () => Promise.reject(new Error('already gone')) }, 1000), true, 'a browser that is already gone is closed for this purpose');
  const started = Date.now();
  assert.equal(await closeBounded({ close: () => new Promise(() => {}) }, 50), false, 'a browser that never exits');
  assert.ok(Date.now() - started < 2000, 'the wait is bounded by the timer, not by the browser');
});
