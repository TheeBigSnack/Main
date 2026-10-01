// What the Edge Function tests (test/fn-*.test.js) run the real handlers
// with, under Node and with no network:
//
//   - the module hook (loader.mjs) that points npm:@supabase/supabase-js@2
//     at fake-supabase.mjs;
//   - a global Deno with env.get (from a map each test sets) and serve,
//     which keeps the handler the function passes it; loadFunction imports
//     the function afresh (a query string on its URL), so each test gets a
//     new instance: its settings read from that test's env, its per-user
//     and per-address brakes empty;
//   - fetch replaced for the whole process: a call to a host a test gave an
//     answer for (Stripe, the Anthropic API) gets that answer, and any other
//     is recorded and refused, so the suite never reaches the network and a
//     test that tried to fails (hermetic() checks it after every test);
//   - invoke, which calls a handler with a real Request and reads the answer.

import { register } from 'node:module';
import { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake } from './fake-supabase.mjs';

// The functions are TypeScript, run as they are deployed: Node strips the
// types itself from 22.18 on (process.features.typescript). An older Node
// would fail every test here with an unknown-extension error; say why instead.
if (!process.features.typescript) throw new Error('the Edge Function tests need Node 22.18 or later, which runs .ts files as they are (.nvmrc says 22)');

register('./loader.mjs', import.meta.url);

export { fake };

// ---------- the project the functions believe they run in ----------

export const SUPABASE_URL = 'https://abcdefghijklmnop.supabase.co';
// Shaped like the publishable key a new project hands out (sb_publishable_...), so
// scripts/check-deploy.mjs takes it for a browser-safe key; it is the
// SUPABASE_ANON_KEY the functions read when SUPABASE_PUBLISHABLE_KEYS is unset.
export const ANON_KEY = 'sb_publishable_anon-key-for-the-function-tests';
export const SERVICE_KEY = 'service-role-key-for-the-function-tests';
export const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
export const BASE_ENV = Object.freeze({ SUPABASE_URL, SUPABASE_ANON_KEY: ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY });

// ---------- Deno ----------

const env = new Map();
let served = null;

globalThis.Deno = {
  env: { get: (name) => env.get(name) },
  serve(handler) {
    served = handler;
    return { finished: Promise.resolve(), shutdown: async () => {} };
  },
};

let fresh = 0;

/**
 * A new instance of one function: the env it starts with (BASE_ENV plus
 * `vars`; a var set to undefined is left unset) and the handler it serves.
 */
export async function loadFunction(name, vars = {}) {
  env.clear();
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...vars })) if (v !== undefined) env.set(k, String(v));
  served = null;
  fresh += 1;
  await import(new URL(`../../supabase/functions/${name}/index.ts?instance=${fresh}`, import.meta.url).href);
  if (typeof served !== 'function') throw new Error(`${name}/index.ts did not call Deno.serve with a handler`);
  return served;
}

// ---------- the network ----------

// host -> (request) => { status, body } | a Response | NETWORK_ERROR
const routes = new Map();
export const net = {
  calls: [], // every outgoing request: { url, host, path, method, headers, body }
  unexpected: [], // requests to a host with no route: the real network, refused
  route(host, answer) {
    routes.set(host, answer);
  },
  to(host) {
    return this.calls.filter((c) => c.host === host);
  },
};
export const NETWORK_ERROR = Symbol('network error');

// A request's signal is honoured as the real fetch honours it: an answer
// that has not come back when the signal aborts never does, the call is
// marked `aborted`, and fetch rejects with the signal's reason. A route may
// answer with a promise, to stand for a slow upstream.
const stopped = (signal) => new Promise((_, reject) => {
  if (!signal) return;
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

globalThis.fetch = async function fakeFetch(input, init = undefined) {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const body = ['GET', 'HEAD'].includes(req.method) ? '' : await req.text();
  const call = { url: req.url, host: url.host, path: url.pathname, query: url.searchParams, method: req.method, headers: Object.fromEntries(req.headers), body, aborted: false };
  net.calls.push(call);
  const answer = routes.get(url.host);
  if (!answer) {
    net.unexpected.push(req.url);
    throw new TypeError(`fetch refused: the function tests never reach the network (${req.method} ${req.url})`);
  }
  const signal = init && init.signal ? init.signal : null;
  let out;
  try {
    out = await Promise.race([Promise.resolve(answer(call)), stopped(signal)]);
  } catch (e) {
    if (signal && signal.aborted) call.aborted = true;
    throw e;
  }
  if (out === NETWORK_ERROR) throw new TypeError('fetch failed');
  if (out instanceof Response) return out;
  return new Response(out.body === undefined ? '{}' : JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'content-type': 'application/json', ...(out.headers || {}) } });
};

// ---------- what the functions print ----------

export const logs = [];
const quiet = { log: console.log, error: console.error, warn: console.warn };

// ---------- calling a handler ----------

/**
 * Calls a handler the way the gateway would and reads the answer.
 *   path:    after /functions/v1/, e.g. 'sync' or 'billing/status?origin=...'
 *   token:   sent as Authorization: Bearer <token>
 *   origin:  the Origin header (default: the extension's)
 *   body:    sent as JSON; `raw` sends that text exactly instead
 *   signal:  the caller's own signal (aborting it is the caller going away)
 * @returns {{ status, headers, body, text }} body is the parsed JSON, or null
 */
export async function invoke(handler, { method = 'POST', path = '', token = '', origin = EXTENSION_ORIGIN, body = undefined, raw = undefined, headers = {}, signal = undefined } = {}) {
  const h = { ...(origin ? { Origin: origin } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), apikey: ANON_KEY, ...headers };
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) payload = JSON.stringify(body);
  if (payload !== undefined && !Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/json';
  const req = new Request(`${SUPABASE_URL}/functions/v1/${path}`, { method, headers: h, body: payload, ...(signal ? { signal } : {}) });
  console.log = (...a) => logs.push(a.map(String).join(' '));
  console.error = console.log;
  console.warn = console.log;
  let res;
  try {
    res = await handler(req);
  } finally {
    Object.assign(console, quiet);
  }
  assert.ok(res instanceof Response, 'the handler answers a Response');
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, headers: res.headers, body: parsed, text };
}

/**
 * A fetch for code that calls the functions by address (the extension's
 * sync and rewriter, scripts/check-deploy.mjs): /functions/v1/<name>/...
 * goes to that function's handler; anything else gets `other(url, init)`,
 * by default a 404.
 */
export function functionsFetch(handlers, other = null) {
  return async (url, init = {}) => {
    const u = new URL(url);
    const m = /^\/functions\/v1\/([^/]+)/.exec(u.pathname);
    if (u.origin === SUPABASE_URL && m && handlers[m[1]]) {
      const req = new Request(url, init);
      console.log = (...a) => logs.push(a.map(String).join(' '));
      console.error = console.log;
      console.warn = console.log;
      try {
        return await handlers[m[1]](req);
      } finally {
        Object.assign(console, quiet);
      }
    }
    if (other) return other(url, init);
    return new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'Requested function was not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  };
}

// ---------- every test ----------

// An empty database, no routes, no calls before each test; after it, no
// request may have tried the real network.
export function hermetic() {
  beforeEach(() => {
    fake.reset();
    routes.clear();
    net.calls = [];
    net.unexpected = [];
    logs.length = 0;
  });
  afterEach(() => {
    assert.deepEqual(net.unexpected, [], 'a function tried to reach the real network');
  });
}

// ---------- small helpers the fn-*.test.js files share ----------

// Stable ids that look like Postgres's (the fake checks uuid columns).
export const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// The keys of an object, sorted, to compare an answer's shape with a contract.
export const keysOf = (o) => Object.keys(o || {}).sort();
