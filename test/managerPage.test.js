// The manager view's page code (manager/manager.js) run in Node: a copy of
// manager.js and data.js in a temporary folder next to a config.js that names
// a made-up project, a stand-in for supabase-js that the test drives, and the
// few browser objects the page touches (document, location, history, fetch).
// No network: every call the page makes lands in these stand-ins. The page
// runs start() as it is imported, so each case imports a fresh copy.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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

// ---------- every row, past the API's row cap ----------

test('loadLive reads every row past the API\'s 1,000-row cap: the oldest open take-down is still on the page', async () => {
  const D = 'd1';
  const NOW = Date.now();
  const at = (hoursAgo) => new Date(NOW - hoursAgo * 3600 * 1000).toISOString();
  const vin = (n) => `TESTVIN${String(n).padStart(10, '0')}`;
  // 1,200 to-do items, all closed but the oldest: a sold car still listed after 1,500 hours
  const todo = Array.from({ length: 1200 }, (_, i) => ({
    id: `t${String(i).padStart(5, '0')}`, dealership_id: D, vin: vin(i), kind: i % 2 ? 'price' : 'takeDown', name: `Car ${i}`,
    flagged_at: at(i + 1), done_at: i === 1198 ? null : at(i), how: i === 1198 ? null : 'detected', from_price: null, to_price: null,
  }));
  todo[1198].name = 'Sold car still up the longest';
  todo[1198].flagged_at = at(1500);
  const listings = Array.from({ length: 1100 }, (_, i) => ({ id: `l${String(i).padStart(5, '0')}`, dealership_id: D, user_id: 'u-sales', vin: vin(i), name: `Car ${i}`, price: 10000 + i, posted_at: at(i + 2), status: 'listed', salesperson: 'Sam' }));
  const client = fakeClient({
    session: { access_token: 'tok', user: { id: 'u-manager', email: 'manager@example.test' } },
    maxRows: 1000,
    tables: {
      dealerships: [{ id: D, name: 'Example Motors', website_origin: 'https://www.example-motors.test' }],
      memberships: [{ user_id: 'u-manager', dealership_id: D, role: 'manager', name: 'Jamie' }, { user_id: 'u-sales', dealership_id: D, role: 'salesperson', name: 'Sam' }],
      listings,
      todo_items: todo,
      post_attempts: [],
      scan_summaries: [{ id: 's1', dealership_id: D, taken_at: at(1), cars: 1100, ready: 1000, take_down_count: 1, price_update_count: 0 }],
    },
  });
  const page = await openPage(PAGE, { client, fetchImpl: () => answer(200, { ok: true, role: 'manager', state: 'pilot', subscription: { status: 'pilot', pilot_ends_at: '2099-01-01T00:00:00Z' } }) });
  const html = main(page);
  assert.match(html, /id="soldStillListed"/, 'the open take-down past the first 1,000 rows is listed');
  assert.match(html, /Sold car still up the longest/);
  assert.match(html, /<td>Everyone<\/td><td class="n">\d+<\/td><td class="n">1100<\/td>/, 'All time counts all 1,100 listings, not the first 1,000');
  const todoReads = client.requests.filter((q) => q.table === 'todo_items');
  assert.ok(todoReads.length >= 2, 'more than one request');
  assert.ok(todoReads.every((q) => q.range), 'each request asks for a range');
  assert.deepEqual(todoReads[0].order.at(-1), ['id', true], 'the order ends on a unique column, so pages neither overlap nor skip');
});

// ---------- what the page says when nothing is flagged ----------

test('nothing flagged, no scan yet, and a removed salesperson\'s cars still up: no all-clear, no green pill, and those cars are named', async () => {
  const D = 'd1';
  const at = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
  const listings = [1, 2, 3, 4, 5].map((n) => ({ id: `l${n}`, dealership_id: D, user_id: n <= 2 ? 'u-sam' : 'u-gone', vin: `TESTVIN${String(n).padStart(10, '0')}`, name: `Car ${n}`, price: 20000 + n, posted_at: at(50 + n), status: 'listed', salesperson: n <= 2 ? 'Sam' : 'Riley', listing_url: `https://www.facebook.com/marketplace/item/${n}/` }));
  const tables = {
    dealerships: [{ id: D, name: 'Example Motors', website_origin: 'https://www.example-motors.test' }],
    memberships: [{ user_id: 'u-manager', dealership_id: D, role: 'manager', name: 'Jamie' }, { user_id: 'u-sam', dealership_id: D, role: 'salesperson', name: 'Sam' }],
    listings,
    todo_items: [],
    post_attempts: [],
    scan_summaries: [],
  };
  const billing = () => answer(200, { ok: true, role: 'manager', state: 'pilot', subscription: { status: 'pilot', pilot_ends_at: '2099-01-01T00:00:00Z' } });
  const page = await openPage(PAGE, { client: fakeClient({ session: { access_token: 'tok', user: { id: 'u-manager', email: 'manager@example.test' } }, tables }), fetchImpl: billing });
  const html = main(page);
  assert.ok(!html.includes('Every sold car is off Marketplace'));
  assert.ok(!html.includes('Every listing shows the website price'));
  assert.match(html, /Sold cars still listed <span class="pill warn">0<\/span>/, 'amber, never green, with no scan and cars nobody watches');
  assert.match(html, /No sold car is flagged on a synced listing\.[^<]*No scan is recorded yet/);
  assert.match(html, /No price change is flagged on a synced listing\./);
  const unwatched = html.slice(html.indexOf('id="unwatched"'));
  assert.ok(html.includes('id="unwatched"'), 'the removed salesperson\'s cars get their own list');
  assert.match(unwatched, /Listings nobody's extension watches <span class="pill warn">3<\/span>/);
  for (const n of [3, 4, 5]) assert.match(unwatched, new RegExp(`>Car ${n}</a><div class="sub">Riley · TESTVIN`));
  assert.ok(!/>Car [12]</.test(unwatched), 'a member\'s cars are not in it');

  // with a fresh scan and the cars all members', the green pill comes back, still saying only what is known
  const fresh = { ...tables, listings: listings.slice(0, 2), scan_summaries: [{ id: 's1', dealership_id: D, taken_at: at(1), cars: 40, ready: 30, take_down_count: 0, price_update_count: 0 }] };
  const ok = main(await openPage(PAGE, { client: fakeClient({ session: { access_token: 'tok', user: { id: 'u-manager', email: 'manager@example.test' } }, tables: fresh }), fetchImpl: billing }));
  assert.match(ok, /Sold cars still listed <span class="pill good">0<\/span>/);
  assert.match(ok, /<p class="empty">No sold car is flagged on a synced listing\. Each salesperson&#39;s extension checks their own listings when it rescans\.<\/p>/);
  assert.ok(!ok.includes('id="unwatched"'));
  assert.ok(readFileSync(join(root, 'docs/help.md'), 'utf8').includes('**Listings nobody\'s extension watches**'), 'docs/help.md names the list as the page labels it');
});
