// The self-hosted rewrite service (backend/server.js) as it runs: started
// in its own process on a free loopback port, with the Anthropic SDK
// replaced by a stand-in (test/backend/fake-anthropic.mjs, through
// test/backend/loader.mjs), so nothing reaches the network. Its usage file
// and the stand-in's call log live in a temporary folder.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rewriteFacts, rewriteWithBackend, REWRITE_TIMEOUT_MS } from '../extension/src/rewriter.js';

const SERVER = new URL('../backend/server.js', import.meta.url).pathname;
const REGISTER = new URL('./backend/register.mjs', import.meta.url).href;
const KEY = 'service-key-for-the-backend-tests';
const dir = mkdtempSync(join(tmpdir(), 'lot-current-backend-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const VEHICLE = {
  vin: '1TESTVEH0NA000123', year: 2021, make: 'Example', model: 'Sedan', trim: 'LX', mileage: 34567, stock: 'A123', price: 20986,
  features: ['Heated seats', 'Backup camera', 'Bluetooth'], carfaxOneOwner: false, carfaxUrl: null, exteriorColor: 'Gray', interiorColor: 'Black',
  bodyType: 'Sedan', engine: '2.0L I4', transmission: 'Automatic', drivetrain: 'FWD', fuelType: 'Gasoline', descriptionRaw: '',
};
const FACTS = rewriteFacts({ vehicle: VEHICLE, dealer: { name: 'Example Motors', city: 'Springfield' }, salesperson: { name: 'Sam', title: 'sales consultant' }, narrative: [] });
const GOOD = "This 2021 Example Sedan LX is ready for its next driver. It shows 34,567 miles and has a gray exterior with a black interior. You get heated seats, a backup camera and Bluetooth, with a smooth automatic transmission and front-wheel drive. It is a comfortable, easy car for daily errands and longer weekend drives alike. Stop by for a look and a test drive whenever it suits you, and I will have it pulled up and ready. Send me a message with any questions about it. I'm Sam, sales consultant at Example Motors.";
const BAD = 'This 2021 Example Sedan is in perfect condition and has 99,999 miles.';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

let runs = 0;
// Starts the service with the stand-in's answers and any of its settings; resolves once it listens.
async function start({ answers = [{ text: GOOD }], key = KEY, deadlineMs = null } = {}) {
  runs += 1;
  const port = await freePort();
  const log = join(dir, `calls-${runs}.jsonl`);
  const env = {
    PATH: process.env.PATH, HOST: '127.0.0.1', PORT: String(port), ANTHROPIC_API_KEY: 'anthropic-key-for-the-backend-tests', REWRITE_KEY: key,
    REWRITE_MODEL: 'test-model', MONTHLY_COST_CAP_USD: '25', RATE_LIMIT_PER_MINUTE: '20', USAGE_FILE: join(dir, `usage-${runs}.json`),
    FAKE_ANTHROPIC: JSON.stringify(answers), FAKE_ANTHROPIC_LOG: log, ...(deadlineMs ? { REWRITE_DEADLINE_MS: String(deadlineMs) } : {}),
  };
  const child = spawn(process.execPath, ['--import', REGISTER, SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the service did not start: ${out}`)), 10_000);
    const read = (chunk) => {
      out += chunk;
      if (/rewrite service on http:/.test(out)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('exit', (code) => reject(new Error(`the service exited (${code}): ${out}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    call: (path, { method = 'POST', body, auth = KEY, signal } = {}) =>
      fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal }),
    stop: () => new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
    }),
  };
}

const json = async (res) => ({ status: res.status, body: await res.json() });

test('backend: /health says only that the service is up without the key; its month, spend, cap and volume need the key', async () => {
  const s = await start();
  try {
    assert.deepEqual(await json(await s.call('/health', { method: 'GET', auth: '' })), { status: 200, body: { ok: true } });
    assert.deepEqual(await json(await s.call('/health', { method: 'GET', auth: 'a-wrong-key' })), { status: 200, body: { ok: true } });
    const ok = await json(await s.call('/rewrite', { body: FACTS }));
    assert.deepEqual([ok.status, ok.body.ok], [200, true]);
    const keyed = await json(await s.call('/health', { method: 'GET' }));
    assert.equal(keyed.status, 200);
    assert.deepEqual(Object.keys(keyed.body).sort(), ['capUsd', 'model', 'month', 'ok', 'requests', 'usd']);
    assert.deepEqual([keyed.body.ok, keyed.body.requests, keyed.body.capUsd], [true, 1, 25]);
    // the rewrite route itself still refuses a call without the key
    assert.equal((await s.call('/rewrite', { body: FACTS, auth: '' })).status, 401);
  } finally {
    await s.stop();
  }
  // with no key set (one machine, loopback only), the figures are open as the routes are
  const open = await start({ key: '' });
  try {
    const h = await json(await open.call('/health', { method: 'GET', auth: '' }));
    assert.deepEqual([h.body.ok, h.body.requests], [true, 0]);
  } finally {
    await open.stop();
  }
});

test('backend: one deadline under the extension\'s wait: a slow call is stopped (504, no cost booked), a second draft starts only with time left, and a caller who leaves stops the call', async () => {
  const source = readFileSync(SERVER, 'utf8');
  const deadline = Number(/deadlineMs: Number\(process\.env\.REWRITE_DEADLINE_MS\) \|\| ([\d_]+)/.exec(source)[1].replace(/_/g, ''));
  assert.ok(deadline > 0 && deadline < REWRITE_TIMEOUT_MS, `${deadline} ms against the extension's ${REWRITE_TIMEOUT_MS}`);

  // a call still running at the deadline is stopped, and its cost is not booked
  const slow = await start({ answers: [{ delayMs: 3000, text: GOOD }], deadlineMs: 300 });
  try {
    const started = Date.now();
    const r = await json(await slow.call('/rewrite', { body: FACTS }));
    assert.ok(Date.now() - started < 2000, 'answered at the deadline');
    assert.deepEqual(r, { status: 504, body: { ok: false, error: 'Claude took too long to answer, so it was stopped; the template is used instead' } });
    assert.deepEqual(slow.calls().map((c) => c.aborted), [true]);
    assert.equal((await json(await slow.call('/health', { method: 'GET' }))).body.requests, 0);
  } finally {
    await slow.stop();
  }

  // a draft the checks refuse, with too little time left: no second draft
  const late = await start({ answers: [{ delayMs: 700, text: BAD }], deadlineMs: 1000 });
  try {
    const r = await json(await late.call('/rewrite', { body: FACTS }));
    assert.deepEqual([r.status, r.body.ok, r.body.error], [200, false, 'the draft failed the checks, and there was no time for a second one']);
    assert.equal(late.calls().length, 1);
  } finally {
    await late.stop();
  }

  // with time left, the second draft is still written
  const twice = await start({ answers: [{ text: BAD }, { text: GOOD }] });
  try {
    const r = await json(await twice.call('/rewrite', { body: FACTS }));
    assert.deepEqual([r.status, r.body.ok], [200, true]);
    assert.equal(twice.calls().length, 2);
  } finally {
    await twice.stop();
  }

  // the caller goes away: the call is stopped and nothing is booked
  const left = await start({ answers: [{ delayMs: 3000, text: GOOD }] });
  try {
    const gone = new AbortController();
    setTimeout(() => gone.abort(), 150);
    await assert.rejects(left.call('/rewrite', { body: FACTS, signal: gone.signal }));
    for (let i = 0; i < 40 && !left.calls().length; i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(left.calls().map((c) => c.aborted), [true], 'the call was stopped when the caller left, not answered later');
    assert.equal((await json(await left.call('/health', { method: 'GET' }))).body.requests, 0);
  } finally {
    await left.stop();
  }
});

test('backend: a body over the size limit is answered with 413 "request too large", not a reset connection, and the service carries on', async () => {
  const s = await start();
  try {
    // just over the 64 KB limit, and a megabyte: read to the end, thrown away, answered
    for (const size of [70 * 1024, 1_000_000]) {
      const r = await json(await s.call('/rewrite', { body: { ...FACTS, narrative: ['x'.repeat(size)] } }));
      assert.deepEqual(r, { status: 413, body: { ok: false, error: 'request too large' } }, `${size} bytes`);
    }
    assert.deepEqual(s.calls(), [], 'nothing too large reaches Claude');
    // the extension shows the service's own words for it
    const note = await rewriteWithBackend({ endpoint: s.base, key: KEY, facts: { ...FACTS, narrative: ['x'.repeat(70 * 1024)] } });
    assert.deepEqual([note.ok, note.error], [false, 'request too large']);
    // a body that never stops is cut off past 16 times the limit
    await assert.rejects(s.call('/rewrite', { body: { ...FACTS, narrative: ['x'.repeat(2_000_000)] } }));
    // and the next request is served as usual
    const ok = await json(await s.call('/rewrite', { body: FACTS }));
    assert.deepEqual([ok.status, ok.body.ok], [200, true]);
  } finally {
    await s.stop();
  }
});
