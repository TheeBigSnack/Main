// The manager view's page code (manager/manager.js) run in Node: a copy of
// manager.js and data.js in a temporary folder next to a config.js that names
// a made-up project, a stand-in for supabase-js that the test drives, and the
// few browser objects the page touches (document, location, history, fetch).
// No network: every call the page makes lands in these stand-ins. The page
// runs start() as it is imported, so each case imports a fresh copy.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const PROJECT = 'https://abcdefgh.supabase.co';
const ANON = 'anon-key-for-tests';
const PAGE = 'https://app.example.test/';

const dir = mkdtempSync(join(tmpdir(), 'lot-current-manager-page-'));
after(() => rmSync(dir, { recursive: true, force: true }));
copyFileSync(join(root, 'manager/manager.js'), join(dir, 'manager.js'));
copyFileSync(join(root, 'manager/data.js'), join(dir, 'data.js'));
writeFileSync(join(dir, 'fake-supabase.mjs'), 'export function createClient(...args) { return globalThis.__managerPageTest.createClient(...args); }\n');
writeFileSync(join(dir, 'config.js'), `export const CONFIG = ${JSON.stringify({ supabaseUrl: PROJECT, supabaseAnonKey: ANON, functionsUrl: '', supabaseJs: pathToFileURL(join(dir, 'fake-supabase.mjs')).href, selfServeSignup: false })};\n`);

// ---------- the browser, as far as the page uses it ----------

function element(id) {
  return {
    id,
    textContent: '',
    innerHTML: '',
    outerHTML: '',
    disabled: false,
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {},
    setAttribute() {},
    focus() {},
    scrollIntoView() {},
    querySelector() { return null; },
  };
}

function browser(href) {
  let url = new URL(href);
  const elements = new Map();
  const fetches = [];
  const history = [];
  const location = {
    get href() { return url.href; },
    get hash() { return url.hash; },
    get search() { return url.search; },
    get pathname() { return url.pathname; },
    get origin() { return url.origin; },
    assign(to) { url = new URL(to, url); },
  };
  globalThis.location = location;
  globalThis.history = { replaceState(_state, _title, to) { url = new URL(to, url); history.push(url.href); } };
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element(id));
      return elements.get(id);
    },
    addEventListener() {},
    createElement: () => element(''),
    body: element('body'),
    activeElement: null,
  };
  return { elements, fetches, history, location, get href() { return url.href; } };
}

// A response the way fetch answers.
const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// supabase-js as far as the page uses it: auth, rpc, and from(table) with
// select / eq / order / limit / range, answering from `tables` and, like the
// hosted API, at most `maxRows` rows per request whatever the range asks for.
function fakeClient({ session = null, tables = {}, maxRows = 1000, seen = {} } = {}) {
  const requests = [];
  const client = {
    requests,
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange() {},
      signOut: async () => ({ error: null }),
      signInWithOtp: async () => ({ error: null }),
    },
    rpc: async (fn) => ({ data: fn === 'list_invites' ? [] : null, error: null }),
    from(table) {
      const q = { table, eq: [], order: [], range: null, limit: null, count: null };
      const builder = {
        select(_cols, opts) { q.count = (opts && opts.count) || null; return builder; },
        eq(col, value) { q.eq.push([col, value]); return builder; },
        order(col, opts) { q.order.push([col, !opts || opts.ascending !== false]); return builder; },
        limit(n) { q.limit = n; return builder; },
        range(from, to) { q.range = [from, to]; return builder; },
        then(resolve, reject) { return Promise.resolve().then(() => run(q)).then(resolve, reject); },
      };
      return builder;
    },
  };
  function run(q) {
    requests.push(q);
    const all = (tables[q.table] || []).filter((r) => q.eq.every(([c, v]) => r[c] === v));
    const sorted = [...all].sort((a, b) => {
      for (const [col, asc] of q.order) {
        const x = String(a[col] ?? '');
        const y = String(b[col] ?? '');
        if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
      }
      return 0;
    });
    const from = q.range ? q.range[0] : 0;
    let to = q.range ? q.range[1] : sorted.length - 1;
    if (q.limit !== null) to = Math.min(to, from + q.limit - 1);
    to = Math.min(to, from + maxRows - 1);
    return { data: sorted.slice(from, to + 1), error: null, count: q.count ? sorted.length : null };
  }
  globalThis.__managerPageTest = {
    createClient(url, key, opts) {
      seen.created = { url, key, opts, href: globalThis.location.href };
      return client;
    },
  };
  return client;
}

let copies = 0;
async function openPage(href, { client, fetchImpl } = {}) {
  const page = browser(href);
  globalThis.fetch = async (url, init = {}) => {
    page.fetches.push({ url: String(url), init });
    return fetchImpl ? fetchImpl(String(url), init) : answer(404, {});
  };
  if (client === undefined) fakeClient();
  copies += 1;
  await import(`${pathToFileURL(join(dir, 'manager.js')).href}?copy=${copies}`);
  for (let i = 0; i < 50; i += 1) await new Promise((r) => setTimeout(r, 0)); // start() runs to its end
  return page;
}

const main = (page) => page.elements.get('main')?.innerHTML || '';
const status = (page) => page.elements.get('status')?.textContent || '';

// ---------- a sign-in answer the page did not ask for ----------

const IMPLICIT = '#access_token=eyJhbGciOiJIUzI1NiJ9.e30.sig&expires_at=1893456000&expires_in=3600&refresh_token=r3fr3sh&token_type=bearer&type=magiclink';

test('a link that lands with #access_token: the tokens leave the address before supabase-js starts, their session is ended, and the page says why', async () => {
  const seen = {};
  const page = await openPage(PAGE + IMPLICIT, { client: fakeClient({ seen }), fetchImpl: () => answer(204, {}) });
  assert.ok(seen.created, 'the client was made');
  assert.doesNotMatch(seen.created.href, /access_token|refresh_token|#/, 'supabase-js never sees the fragment, so it cannot wipe a session this browser already holds');
  assert.equal(page.href, PAGE, 'the address bar keeps no token');
  assert.ok(page.history.every((h) => !/access_token|refresh_token/.test(h)), 'no history entry the page wrote holds a token');
  const logout = page.fetches.find((f) => f.url.startsWith(`${PROJECT}/auth/v1/logout`));
  assert.ok(logout, 'the session the tokens opened is ended');
  assert.equal(logout.url, `${PROJECT}/auth/v1/logout?scope=local`, 'only that session, never the person\'s others');
  assert.equal(logout.init.method, 'POST');
  assert.equal(logout.init.headers.apikey, ANON);
  assert.equal(logout.init.headers.Authorization, 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig');
  assert.match(main(page), /<h2>Sign in<\/h2>/, 'not signed in by it');
  assert.match(status(page), /not asked for on this page/);
  assert.match(status(page), /new code/);
});

test('a link that lands with the auth server\'s #error: the fragment leaves the address, nothing is called, and the page says the link did not work', async () => {
  const seen = {};
  const page = await openPage(PAGE + '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', { client: fakeClient({ seen }) });
  assert.doesNotMatch(seen.created.href, /error|#/);
  assert.doesNotMatch(page.href, /#|error/);
  assert.equal(page.fetches.filter((f) => f.url.includes('/auth/v1/logout')).length, 0, 'no token, nothing to end');
  assert.match(status(page), /did not work/);
  assert.doesNotMatch(status(page), /invalid or has expired/, 'the address\'s own words are never shown: anyone can write them into a link');
});

test('an address with neither tokens nor an error is left as it is', async () => {
  const seen = {};
  const page = await openPage(PAGE + '#section', { client: fakeClient({ seen }) });
  assert.equal(seen.created.href, PAGE + '#section');
  assert.equal(page.fetches.length, 0);
  assert.equal(status(page), '');
});

test('a ?code= this browser could not exchange leaves the address, and the sign-in form says why', async () => {
  const page = await openPage(PAGE + '?code=0b2f6f8e-1111-4222-8333-944455556666');
  assert.equal(page.href, PAGE, 'the dead code leaves the address');
  assert.match(main(page), /<h2>Sign in<\/h2>/);
  assert.match(status(page), /did not sign you in here/);
});

test('a stray #access_token on a browser already signed in: the person stays signed in, and only the stray session is ended', async () => {
  const seen = {};
  const me = { access_token: 'my-own-token', user: { id: 'u-manager', email: 'manager@example.test' } };
  const client = fakeClient({
    seen,
    session: me,
    tables: {
      dealerships: [{ id: 'd1', name: 'Example Motors', website_origin: 'https://www.example-motors.test' }],
      memberships: [{ user_id: 'u-manager', dealership_id: 'd1', role: 'manager', name: 'Jamie' }],
    },
  });
  const page = await openPage(PAGE + IMPLICIT, {
    client,
    fetchImpl: (url) => (url.includes('/billing/status') ? answer(200, { ok: true, role: 'manager', state: 'pilot', subscription: { status: 'pilot', pilot_ends_at: '2099-01-01T00:00:00Z' } }) : answer(204, {})),
  });
  assert.doesNotMatch(seen.created.href, /access_token/);
  assert.equal(page.elements.get('dealer').textContent, 'Example Motors', 'the dealership\'s numbers, not the sign-in form');
  const logouts = page.fetches.filter((f) => f.url.includes('/auth/v1/logout'));
  assert.equal(logouts.length, 1);
  assert.equal(logouts[0].init.headers.Authorization, 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig', 'the stray token\'s session, never the person\'s own');
});
