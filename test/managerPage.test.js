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
// config.js is one module for every copy of the page, so it hands out one object each case may change (openPage's billing)
globalThis.__managerPageConfig = { supabaseUrl: PROJECT, supabaseAnonKey: ANON, functionsUrl: '', supabaseJs: pathToFileURL(join(dir, 'fake-supabase.mjs')).href, selfServeSignup: false, billing: true };
writeFileSync(join(dir, 'config.js'), 'export const CONFIG = globalThis.__managerPageConfig;\n');

// ---------- the browser, as far as the page uses it ----------

function element(id) {
  return {
    id,
    textContent: '',
    innerHTML: '',
    outerHTML: '',
    value: '',
    disabled: false,
    dataset: {},
    listeners: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, fn) { this.listeners[type] = fn; }, // the latest render's handler
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
  const listeners = [];
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
    addEventListener(type, fn) { if (type === 'click') listeners.push(fn); },
    createElement: () => element(''),
    body: element('body'),
    activeElement: null,
  };
  // A click on a button the page drew: <button data-action="..." data-...>label</button>
  const click = (dataset, label = '') => {
    const btn = { dataset, textContent: label, disabled: false };
    for (const fn of listeners) fn({ target: { closest: () => btn } });
    return btn;
  };
  return { elements, fetches, history, location, click, get href() { return url.href; } };
}

// Lets the page's promises run to their end.
const settle = async (turns = 50) => { for (let i = 0; i < turns; i += 1) await new Promise((r) => setTimeout(r, 0)); };

// A response the way fetch answers.
const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// supabase-js as far as the page uses it: auth, rpc, and from(table) with
// select / eq / lte / gt / order / limit / range, answering from `tables`
// and, like the hosted API, at most `maxRows` rows per request whatever the
// range asks for, and with select's count: 'exact', how many rows match. A
// filter on a column `missingColumns` names for its table is answered with
// Postgres's undefined-column error, as a database without that migration.
function fakeClient({ session = null, tables = {}, maxRows = 1000, seen = {}, rpcs = {}, missingColumns = {} } = {}) {
  const requests = [];
  const client = {
    requests,
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange() {},
      signOut: async (opts) => { requests.push({ signOut: opts }); return { error: null }; },
      signInWithOtp: async () => ({ error: null }),
    },
    rpc: async (fn, args) => {
      requests.push({ rpc: fn, args });
      return rpcs[fn] ? rpcs[fn](args) : { data: fn === 'list_invites' ? [] : null, error: null };
    },
    from(table) {
      const q = { table, eq: [], lte: [], gt: [], order: [], range: null, limit: null, count: null };
      const builder = {
        select(_cols, opts) { q.count = (opts && opts.count) || null; return builder; },
        update(patch) { q.update = patch; return builder; },
        delete() { q.delete = true; return builder; },
        eq(col, value) { q.eq.push([col, value]); return builder; },
        lte(col, value) { q.lte.push([col, value]); return builder; },
        gt(col, value) { q.gt.push([col, value]); return builder; },
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
    const missing = [...q.eq, ...q.lte, ...q.gt].find(([c]) => (missingColumns[q.table] || []).includes(c));
    if (missing) return { data: null, error: { code: '42703', message: `column ${q.table}.${missing[0]} does not exist` }, count: null };
    const all = (tables[q.table] || []).filter((r) => q.eq.every(([c, v]) => r[c] === v) && q.lte.every(([c, v]) => r[c] != null && String(r[c]) <= String(v)) && q.gt.every(([c, v]) => r[c] != null && String(r[c]) > String(v)));
    if (q.update) { for (const r of all) Object.assign(r, q.update); return { data: all.map((r) => ({ ...r })), error: null }; }
    if (q.delete) { tables[q.table] = (tables[q.table] || []).filter((r) => !all.includes(r)); return { data: all.map((r) => ({ ...r })), error: null }; }
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
async function openPage(href, { client, fetchImpl, billing = true } = {}) {
  globalThis.__managerPageConfig.billing = billing;
  const page = browser(href);
  globalThis.fetch = async (url, init = {}) => {
    page.fetches.push({ url: String(url), init });
    return fetchImpl ? fetchImpl(String(url), init) : answer(404, {});
  };
  if (client === undefined) fakeClient();
  copies += 1;
  await import(`${pathToFileURL(join(dir, 'manager.js')).href}?copy=${copies}`);
  await settle(); // start() runs to its end
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

// GoTrue sends a refused link of the PKCE flow (expired, used, replaced by
// a newer email) back with the error in the query as well as the fragment.
// supabase-js reads the query too, and takes an error_description there for
// a failed sign-in: it would remove a session this browser already holds.
const REFUSED = 'error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';

test('a refused link of this page\'s own (the error in the query and the fragment): both leave the address before supabase-js starts, and the page says the link did not work', async () => {
  const seen = {};
  const page = await openPage(`${PAGE}?${REFUSED}#${REFUSED}`, { client: fakeClient({ seen }) });
  assert.doesNotMatch(seen.created.href, /error|#/, 'supabase-js never sees the error, so it cannot wipe a session this browser holds');
  assert.equal(page.href, PAGE, 'the address bar keeps none of the error\'s words');
  assert.ok(page.history.every((h) => !/error/.test(h)));
  assert.equal(page.fetches.filter((f) => f.url.includes('/auth/v1/logout')).length, 0);
  assert.match(main(page), /<h2>Sign in<\/h2>/);
  assert.match(status(page), /did not work: it may have expired, been used already, or been replaced by a newer email/);
  assert.doesNotMatch(status(page), /invalid or has expired/, 'the address\'s own words are never shown');
});

test('the error in the query alone gets the same sentence, and the rest of the address stays', async () => {
  const seen = {};
  const page = await openPage(`${PAGE}?mode=x&${REFUSED}`, { client: fakeClient({ seen }) });
  assert.doesNotMatch(seen.created.href, /error/);
  assert.equal(page.href, `${PAGE}?mode=x`, 'only the error parameters leave');
  assert.match(status(page), /did not work/);
});

test('a refused link opened in a browser that is already signed in: the person stays signed in', async () => {
  const seen = {};
  const client = fakeClient({
    seen,
    session: { access_token: 'my-own-token', user: { id: 'u-manager', email: 'manager@example.test' } },
    tables: {
      dealerships: [{ id: 'd1', name: 'Example Motors', website_origin: 'https://www.example-motors.test' }],
      memberships: [{ user_id: 'u-manager', dealership_id: 'd1', role: 'manager', name: 'Jamie' }],
    },
  });
  const page = await openPage(`${PAGE}?${REFUSED}#${REFUSED}`, { client, fetchImpl: () => answer(200, { ok: true, role: 'manager', state: 'pilot', subscription: { status: 'pilot', pilot_ends_at: '2099-01-01T00:00:00Z' } }) });
  assert.doesNotMatch(seen.created.href, /error/);
  assert.equal(page.elements.get('dealer').textContent, 'Example Motors');
  assert.equal(page.href, PAGE);
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
      scan_summaries: [{ id: 's1', dealership_id: D, taken_at: at(1), cars: 1100, ready: 1000, take_down_count: 1, price_update_count: 0, withheld: false }],
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
  assert.match(html, /Sold cars still listed <span class="pill warn">0<\/span>/, 'amber, never green, with no scan and cars listed by people no longer on the team');
  assert.match(html, /No open take-down items\.[^<]*No scan is recorded yet/);
  assert.match(html, /No open price items\./);
  const notOnTeam = html.slice(html.indexOf('id="notOnTeam"'));
  assert.ok(html.includes('id="notOnTeam"'), 'the removed salesperson\'s cars get their own list');
  assert.match(notOnTeam, /Listed by people no longer on the team <span class="pill warn">3<\/span>/);
  for (const n of [3, 4, 5]) assert.match(notOnTeam, new RegExp(`>Car ${n}</a><div class="sub">Riley · TESTVIN`));
  assert.ok(!/>Car [12]</.test(notOnTeam), 'a member\'s cars are not in it');

  // with a fresh scan and the cars all members', the pill is the plain one, never green, and the card says only what an item is
  const fresh = { ...tables, listings: listings.slice(0, 2), scan_summaries: [{ id: 's1', dealership_id: D, taken_at: at(1), cars: 40, ready: 30, take_down_count: 0, price_update_count: 0, withheld: false }] };
  const ok = main(await openPage(PAGE, { client: fakeClient({ session: { access_token: 'tok', user: { id: 'u-manager', email: 'manager@example.test' } }, tables: fresh }), fetchImpl: billing }));
  assert.match(ok, /Sold cars still listed <span class="pill ">0<\/span>/);
  assert.ok(!ok.includes('class="pill good">0<'), 'an empty card is never green');
  assert.match(ok, /<p class="empty">No open take-down items\. One opens when a rescan on the poster&#39;s own computer finds their car gone from the website\.<\/p>/);
  assert.ok(!ok.includes('id="notOnTeam"'));
  assert.ok(readFileSync(join(root, 'docs/help.md'), 'utf8').includes('**Listed by people no longer on the team**'), 'docs/help.md names the list as the page labels it');
});

// ---------- the last scan, past a long run of held-back scans ----------

// A lot that keeps reading most of its cars gone sends a held-back scan at
// every rescan until a salesperson accepts the smaller list: 3 salespeople
// rescanning every 3 hours make 50 of them in about two days. However many
// there are, the last trusted scan stays the page's last scan, and the line
// counts every one held back since it.
test('loadLive: 60 held-back scans after the last trusted one: the page still shows that scan as the last, and counts all 60', async () => {
  const D = 'd1';
  const at = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
  const held = Array.from({ length: 60 }, (_, i) => ({ id: `h${String(i).padStart(3, '0')}`, dealership_id: D, website_origin: 'https://www.example-motors.test', taken_at: at(1 + i), cars: 4, ready: 3, take_down_count: 0, price_update_count: 0, withheld: true }));
  const scans = [
    ...held,
    { id: 's-trusted', dealership_id: D, website_origin: 'https://www.example-motors.test', taken_at: at(70), cars: 40, ready: 30, take_down_count: 0, price_update_count: 0, withheld: false },
    { id: 's-older-held', dealership_id: D, website_origin: 'https://www.example-motors.test', taken_at: at(80), cars: 3, ready: 3, take_down_count: 0, price_update_count: 0, withheld: true },
    { id: 's-other-dealer', dealership_id: 'd2', website_origin: 'https://www.other-motors.test', taken_at: at(0.5), cars: 90, ready: 80, take_down_count: 0, price_update_count: 0, withheld: false },
  ];
  const client = fakeClient({
    session: { access_token: 'tok', user: { id: 'u-manager', email: 'manager@example.test' } },
    tables: {
      dealerships: [{ id: D, name: 'Example Motors', website_origin: 'https://www.example-motors.test' }],
      memberships: [{ user_id: 'u-manager', dealership_id: D, role: 'manager', name: 'Jamie' }],
      listings: [],
      todo_items: [],
      post_attempts: [],
      scan_summaries: scans,
    },
  });
  const page = await openPage(PAGE, { client, fetchImpl: () => answer(200, { ok: true, role: 'manager', state: 'pilot', subscription: { status: 'pilot', pilot_ends_at: '2099-01-01T00:00:00Z' } }) });
  const html = main(page);
  assert.match(html, /Last scan [^:]+:\d\d: 40 cars on the website, 30 ready to post, 0 to take down, 0 price changes\. 60 later scans \(the newest [^)]*: 4 cars on the website\) were held back as a likely website hiccup/, 'the trusted scan is the last scan, with every held-back scan since it counted');
  assert.doesNotMatch(html, /No trusted scan is recorded yet/);
  assert.doesNotMatch(html, /Every scan recorded was held back/);
  assert.match(html, /The scans since the last trusted one were held back as a likely website hiccup, so a car sold since then is not flagged yet\./);
  // the page asked the database for what the line needs, not a capped run of the newest rows
  const scanReads = client.requests.filter((q) => q.table === 'scan_summaries');
  assert.ok(scanReads.every((q) => q.eq.some(([c, v]) => c === 'dealership_id' && v === D)), 'only this dealership\'s scans');
  assert.ok(scanReads.some((q) => q.eq.some(([c, v]) => c === 'withheld' && v === false)), 'the last trusted scan is read on its own');
  assert.ok(scanReads.some((q) => q.count === 'exact' && q.eq.some(([c, v]) => c === 'withheld' && v === true)), 'the held-back scans are counted');
});

// The page deploys on its own (a push that touches it), so it can reach a
// database that has not applied 0014 yet. Such a database holds no
// held-back scan (the sync function that writes one deploys after it), and
// the page shows its newest scan as before rather than failing to load.
test('loadLive: a database without the withheld column (0014 not applied yet): the newest scan is the last scan, and the page loads', async () => {
  const D = 'd1';
  const at = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
  const client = fakeClient({
    session: { access_token: 'tok', user: { id: 'u-manager', email: 'manager@example.test' } },
    missingColumns: { scan_summaries: ['withheld'] },
    tables: {
      dealerships: [{ id: D, name: 'Example Motors', website_origin: 'https://www.example-motors.test' }],
      memberships: [{ user_id: 'u-manager', dealership_id: D, role: 'manager', name: 'Jamie' }],
      listings: [],
      todo_items: [],
      post_attempts: [],
      scan_summaries: [
        { id: 's1', dealership_id: D, taken_at: at(5), cars: 38, ready: 28, take_down_count: 0, price_update_count: 0 },
        { id: 's2', dealership_id: D, taken_at: at(1), cars: 40, ready: 30, take_down_count: 1, price_update_count: 0 },
      ],
    },
  });
  const page = await openPage(PAGE, { client, fetchImpl: () => answer(200, { ok: true, role: 'manager', state: 'pilot', subscription: { status: 'pilot', pilot_ends_at: '2099-01-01T00:00:00Z' } }) });
  const html = main(page);
  assert.doesNotMatch(status(page), /Couldn't read/);
  assert.match(html, /Last scan [^:]+:\d\d: 40 cars on the website, 30 ready to post, 1 to take down, 0 price changes <span class="pill ">/);
  assert.doesNotMatch(html, /held back/);
});

// ---------- in no dealership yet ----------

// Until sign-up opens, the owner's first-manager code (and every code a
// manager makes) is redeemed in the extension alone: the page never calls
// redeem_invite. Someone holding a code who opens the page first is told
// where it goes, under the extension's own labels, not only to ask the
// person who just gave it to them.
test('signed in and in no dealership, with sign-up closed: the page says where an invite code goes, with the extension\'s labels, and whom to ask otherwise', async () => {
  const client = fakeClient({ session: { access_token: 'tok', user: { id: 'u-new', email: 'new.manager@example.test' } }, tables: { dealerships: [] } });
  const page = await openPage(PAGE, { client });
  const html = main(page);
  assert.match(html, /Your account is not a member of any dealership yet\./);
  assert.match(html, /If you were given an invite code: in the Lot Current extension, sign in under Settings, Account with this same email, enter the code under Invite code and click Join, then reload this page\./);
  assert.match(html, /Otherwise ask whoever set Lot Current up for your store to add you\./);
  assert.match(html, /data-action="signout">Sign out</);
  assert.ok(!client.requests.some((r) => r.rpc === 'redeem_invite'), 'the page redeems no code itself');
  // the words it names are the extension's own
  const popup = readFileSync(join(root, 'extension/popup.js'), 'utf8');
  assert.match(popup, /<legend>Account<\/legend>/);
  assert.match(popup, /field\('Invite code', 'inviteCode'/);
  assert.match(popup, /data-action="accountJoin">Join</);
  assert.match(readFileSync(join(root, 'docs/help.md'), 'utf8'), /sends you an invite code, and the page says where it goes: in the extension, sign in under \*\*Settings\*\*, \*\*Account\*\* with the same email you use here, enter the code under \*\*Invite code\*\*, click \*\*Join\*\*, then reload the manager view/);
});

// ---------- signing out ----------

test('Sign out ends this browser\'s session only, so the person\'s extension and other browsers stay signed in', async () => {
  const client = fakeClient({
    session: { access_token: 'tok', user: { id: 'u-manager', email: 'manager@example.test' } },
    tables: {
      dealerships: [{ id: 'd1', name: 'Example Motors', website_origin: 'https://www.example-motors.test' }],
      memberships: [{ user_id: 'u-manager', dealership_id: 'd1', role: 'manager', name: 'Jamie' }],
    },
  });
  const page = await openPage(PAGE, { client, fetchImpl: () => answer(200, { ok: true, role: 'manager', state: 'pilot', subscription: { status: 'pilot', pilot_ends_at: '2099-01-01T00:00:00Z' } }) });
  assert.equal(page.elements.get('dealer').textContent, 'Example Motors');
  page.click({ action: 'signout' }, 'Sign out');
  await settle();
  const signOuts = client.requests.filter((r) => 'signOut' in r);
  assert.equal(signOuts.length, 1);
  assert.deepEqual(signOuts[0].signOut, { scope: 'local' }, 'supabase-js\'s default scope is global: it would end every session the person has');
  assert.match(main(page), /<h2>Sign in<\/h2>/);
  assert.equal(status(page), 'Signed out.');
});

// ---------- two dealerships ----------

const ALPHA = 'aaaaaaaa-0000-4000-8000-000000000001';
const BRAVO = 'bbbbbbbb-0000-4000-8000-000000000002';
const ME = { access_token: 'tok', user: { id: 'u-manager', email: 'manager@example.test' } };
const DAY = 24 * 3600 * 1000;
const twoDealerships = () => ({
  dealerships: [
    { id: ALPHA, name: 'Alpha Motors', website_origin: 'https://www.alpha-motors.test' },
    { id: BRAVO, name: 'Bravo Auto', website_origin: 'https://www.bravo-auto.test' },
  ],
  memberships: [
    { user_id: 'u-manager', dealership_id: ALPHA, role: 'manager', name: 'Jamie' },
    { user_id: 'u-sam', dealership_id: ALPHA, role: 'salesperson', name: 'Sam' },
    { user_id: 'u-manager', dealership_id: BRAVO, role: 'manager', name: 'Jamie' },
    { user_id: 'u-riley', dealership_id: BRAVO, role: 'salesperson', name: 'Riley' },
  ],
});
const PILOT = { ok: true, role: 'manager', state: 'pilot', canManageBilling: false, subscription: { status: 'pilot', pilot_ends_at: '2099-01-01T00:00:00Z' } };
const madeCode = (args) => ({ data: { code: 'NEWCODE00001', dealership_id: args.dealership_id, role: args.role }, error: null });

test('picking one dealership and then another before the first has loaded: the page settles on the last pick, and every button acts on the dealership shown', async () => {
  const client = fakeClient({ session: ME, tables: twoDealerships(), rpcs: { create_invite: madeCode } });
  let bravoAnswers = null;
  const fetchImpl = (url) => (url.includes(`dealershipId=${BRAVO}`)
    ? new Promise((resolve) => { bravoAnswers = () => resolve(answer(200, { ok: true, role: 'manager', state: 'none', canStartPilot: true, subscription: null })); }) // a cold function, answering last
    : answer(200, PILOT));
  const page = await openPage(PAGE, { client, fetchImpl });
  const dealer = () => page.elements.get('dealer').textContent;
  assert.equal(dealer(), 'Alpha Motors', 'the first by name opens');
  const sel = page.elements.get('pickDealer');

  sel.value = BRAVO;
  sel.listeners.change();
  await settle();
  assert.ok(bravoAnswers, 'Bravo\'s rows are read; its plan has not answered yet');
  assert.equal(dealer(), 'Alpha Motors', 'Alpha stays on screen until Bravo is loaded');
  page.click({ action: 'invite', role: 'salesperson' }, 'Invite a salesperson');
  await settle();
  assert.equal(client.requests.filter((r) => r.rpc === 'create_invite').at(-1).args.dealership_id, ALPHA, 'a click on Alpha\'s card while Bravo loads acts on Alpha');

  sel.value = ALPHA;
  sel.listeners.change();
  await settle();
  bravoAnswers();
  await settle();
  assert.equal(dealer(), 'Alpha Motors', 'Bravo\'s late answer is dropped: the last pick wins');
  assert.match(page.elements.get('actions').innerHTML, new RegExp(`<option value="${ALPHA}" selected>Alpha Motors</option>`), 'the picker and the header agree');
  assert.match(main(page), /Billing <span class="pill good">Free pilot<\/span>/, 'Alpha\'s own plan, not Bravo\'s "No plan yet"');
  assert.doesNotMatch(main(page), /data-billing="pilot"/, 'no Start the free pilot button from Bravo\'s answer');
  assert.match(main(page), /Sam/, 'Alpha\'s team');
  assert.doesNotMatch(main(page), /Riley/);
  page.click({ action: 'invite', role: 'salesperson' }, 'Invite a salesperson');
  await settle();
  assert.equal(client.requests.filter((r) => r.rpc === 'create_invite').at(-1).args.dealership_id, ALPHA, 'the invite is for the dealership on screen');
});

test('a dealership picked and loaded: the header, the picker, the plan, the team and the buttons all move to it together', async () => {
  const client = fakeClient({ session: ME, tables: twoDealerships(), rpcs: { create_invite: madeCode } });
  const fetchImpl = (url) => answer(200, url.includes(`dealershipId=${BRAVO}`) ? { ok: true, role: 'manager', state: 'none', canStartPilot: true, subscription: null } : PILOT);
  const page = await openPage(PAGE, { client, fetchImpl });
  const sel = page.elements.get('pickDealer');
  sel.value = BRAVO;
  sel.listeners.change();
  await settle();
  assert.equal(page.elements.get('dealer').textContent, 'Bravo Auto');
  assert.match(page.elements.get('actions').innerHTML, new RegExp(`<option value="${BRAVO}" selected>Bravo Auto</option>`));
  assert.match(main(page), /Riley/);
  page.click({ action: 'billing', billing: 'pilot' }, 'Start the free pilot');
  page.click({ action: 'invite', role: 'salesperson' }, 'Invite a salesperson');
  await settle();
  assert.equal(client.requests.find((r) => r.rpc === 'start_pilot').args.dealership_id, BRAVO);
  assert.equal(client.requests.find((r) => r.rpc === 'create_invite').args.dealership_id, BRAVO);
});

// ---------- an answer after another dealership was picked ----------

const NO_PLAN = { ok: true, role: 'manager', state: 'none', canStartPilot: true, subscription: null };

test('Start the free pilot answering after another dealership was picked: it started where it was pressed, and its note stays off the other card', async () => {
  for (const order of ['the pick loads first', 'the pilot answers first']) {
    let pilotAnswers = null;
    let bravoAnswers = null;
    const client = fakeClient({ session: ME, tables: twoDealerships(), rpcs: { start_pilot: (args) => new Promise((resolve) => { pilotAnswers = () => resolve({ data: { dealership_id: args.dealership_id, started: true }, error: null }); }) } });
    const slowBravo = order === 'the pilot answers first';
    const fetchImpl = (url) => (slowBravo && url.includes(`dealershipId=${BRAVO}`) ? new Promise((resolve) => { bravoAnswers = () => resolve(answer(200, NO_PLAN)); }) : answer(200, NO_PLAN));
    const page = await openPage(PAGE, { client, fetchImpl });
    assert.equal(page.elements.get('dealer').textContent, 'Alpha Motors', order);
    page.click({ action: 'billing', billing: 'pilot' }, 'Start the free pilot');
    await settle();
    const sel = page.elements.get('pickDealer');
    sel.value = BRAVO;
    sel.listeners.change();
    await settle();
    pilotAnswers();
    await settle();
    if (bravoAnswers) bravoAnswers();
    await settle();
    assert.equal(client.requests.find((r) => r.rpc === 'start_pilot').args.dealership_id, ALPHA, `${order}: the pilot is Alpha's`);
    assert.equal(page.elements.get('dealer').textContent, 'Bravo Auto', `${order}: the pick is kept`);
    assert.doesNotMatch(main(page), /The free pilot has started/, `${order}: not on Bravo's page`);
    assert.doesNotMatch(page.elements.get('billing')?.outerHTML || '', /The free pilot has started/, `${order}: not on a redrawn Billing card`);
  }
});

test('a role change answering while another dealership loads: the change is made where it was pressed, the pick is kept, and its sentence stays off the other card', async () => {
  const client = fakeClient({ session: ME, tables: twoDealerships() });
  let bravoAnswers = null;
  const fetchImpl = (url) => (url.includes(`dealershipId=${BRAVO}`) ? new Promise((resolve) => { bravoAnswers = () => resolve(answer(200, PILOT)); }) : answer(200, PILOT));
  const page = await openPage(PAGE, { client, fetchImpl });
  const sel = page.elements.get('pickDealer');
  sel.value = BRAVO;
  sel.listeners.change();
  await settle();
  assert.equal(page.elements.get('dealer').textContent, 'Alpha Motors', 'Bravo is still loading');
  page.click({ action: 'role', user: 'u-sam', to: 'manager' }, 'Make manager');
  await settle();
  const change = client.requests.find((r) => r.table === 'memberships' && r.update);
  assert.deepEqual([change.update, change.eq], [{ role: 'manager' }, [['user_id', 'u-sam'], ['dealership_id', ALPHA]]], 'the change is for the dealership on screen when it was pressed');
  bravoAnswers();
  await settle();
  assert.equal(page.elements.get('dealer').textContent, 'Bravo Auto', 'the pick is not undone by a reload of Alpha');
  assert.match(main(page), /Riley/);
  assert.doesNotMatch(main(page), /Sam is now a manager/, 'Alpha\'s sentence is not on Bravo\'s Team card');
});

// ---------- back from Stripe ----------

test('Checkout and the portal are told to come back to the dealership the button was pressed for', async () => {
  const client = fakeClient({ session: ME, tables: twoDealerships() });
  const posts = [];
  const fetchImpl = (url, init) => {
    if (init.method === 'POST') {
      posts.push({ url, body: JSON.parse(init.body) });
      return answer(200, { ok: true, url: 'https://billing.stripe.test/session' });
    }
    return answer(200, url.includes(`dealershipId=${BRAVO}`) ? { ok: true, role: 'manager', state: 'active', canManageBilling: true, subscription: { status: 'active', stripe_customer_id: 'cus_b', stripe_subscription_id: 'sub_b', seats: 5 } } : PILOT);
  };
  const page = await openPage(PAGE, { client, fetchImpl });
  const sel = page.elements.get('pickDealer');
  sel.value = BRAVO;
  sel.listeners.change();
  await settle();
  assert.equal(page.elements.get('dealer').textContent, 'Bravo Auto');
  page.click({ action: 'billing', billing: 'portal' }, 'Manage billing');
  await settle();
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith('/billing/portal'));
  assert.equal(posts[0].body.dealershipId, BRAVO);
  assert.equal(posts[0].body.returnUrl, `${PAGE}?dealership=${BRAVO}`, 'the return address names the dealership');
  assert.equal(page.href, 'https://billing.stripe.test/session');
});

test('back from Checkout for the second dealership by name: that one opens, the note is on its card, and the address is clean', async () => {
  const client = fakeClient({ session: ME, tables: twoDealerships() });
  const fetchImpl = (url) => answer(200, url.includes(`dealershipId=${BRAVO}`) ? { ok: true, role: 'manager', state: 'none', canStartPilot: true, canSubscribe: true, subscription: null } : PILOT);
  const page = await openPage(`${PAGE}?dealership=${BRAVO}&billing=success`, { client, fetchImpl });
  assert.equal(page.elements.get('dealer').textContent, 'Bravo Auto', 'not the first dealership by name');
  assert.match(page.elements.get('actions').innerHTML, new RegExp(`<option value="${BRAVO}" selected>Bravo Auto</option>`));
  assert.match(main(page), /<section class="card" id="billing"><h2>Billing[^]*?Checkout is done\./, 'the note is on the paid dealership\'s card');
  const statusCalls = page.fetches.filter((f) => f.url.includes('/billing/status'));
  assert.ok(statusCalls.length >= 1 && statusCalls.every((f) => f.url.includes(`dealershipId=${BRAVO}`)), 'only Bravo\'s plan is read');
  assert.equal(page.href, PAGE, 'the dealership and the flag leave the address, so a reload repeats neither');
});

test('a return that names a dealership the person is not in: the first opens, without the note', async () => {
  const client = fakeClient({ session: ME, tables: twoDealerships() });
  const page = await openPage(`${PAGE}?dealership=cccccccc-0000-4000-8000-000000000003&billing=success`, { client, fetchImpl: () => answer(200, PILOT) });
  assert.equal(page.elements.get('dealer').textContent, 'Alpha Motors');
  assert.doesNotMatch(main(page), /Checkout is done/, 'the note is not about this dealership');
  assert.equal(page.href, PAGE);
});

// ---------- before billing opens ----------

// config.js billing false: the billing function is not deployed yet (it
// comes with Stripe). The page must not call it or show an error for it. The
// free pilot is start_pilot() in the database, so the manager of a dealership
// with no plan still starts it from the Billing card, as PILOT.md and
// supabase/README.md step 5 say, and Getting started points there.
const BILLING_CLOSED_NOTE = 'Paying by card is not open yet, so nothing is charged; to carry on after the free pilot, ask your Lot Current contact.';
const billingCardOf = (html) => html.slice(html.indexOf('<section class="card" id="billing">'), html.indexOf('</section>', html.indexOf('id="billing"')));

test('before billing opens: a manager with no plan starts the free pilot from the Billing card through the database alone, and no billing route is called', async () => {
  const tables = { ...twoDealerships(), subscriptions: [] };
  const word = () => (tables.subscriptions.some((x) => x.dealership_id === ALPHA) ? 'pilot' : 'none');
  const client = fakeClient({
    session: ME,
    tables,
    rpcs: {
      subscription_state: () => ({ data: word(), error: null }),
      start_pilot: (args) => {
        const row = { dealership_id: args.dealership_id, status: 'pilot', pilot_ends_at: new Date(Date.now() + 29.5 * DAY).toISOString(), seats: 5 };
        tables.subscriptions.push(row);
        return { data: { dealership_id: args.dealership_id, started: true, status: 'pilot', pilot_ends_at: row.pilot_ends_at, state: 'pilot' }, error: null };
      },
    },
  });
  const page = await openPage(PAGE, { client, billing: false });
  assert.equal(page.elements.get('dealer').textContent, 'Alpha Motors');
  let html = main(page);
  let card = billingCardOf(html);
  assert.match(card, /Billing <span class="pill ">No plan yet<\/span>/);
  assert.match(card, /No plan yet\. Start the free pilot: no card\./);
  assert.ok(card.includes(`<p class="hint">${BILLING_CLOSED_NOTE}</p>`), 'the card says paying by card is not open yet');
  assert.match(card, /data-billing="pilot"[^>]*>Start the free pilot<\/button>/);
  assert.doesNotMatch(card, /data-billing="(subscribe|portal|reload)"|Couldn&#39;t read the plan/, 'nothing that needs the billing function, and no error');
  assert.match(html, /<span class="name">Start the free pilot<\/span><span class="pill ">To do<\/span><button type="button" class="ghost" data-action="goto" data-target="billing">Go to Billing<\/button>/, 'Getting started points at the card that can do it');
  assert.match(html, /Getting started <span class="pill ">1 of 4 done<\/span>/);
  assert.doesNotMatch(html, /or subscribe/, 'nothing asks for what the page cannot do yet');

  page.click({ action: 'billing', billing: 'pilot' }, 'Start the free pilot');
  await settle();
  const started = client.requests.filter((r) => r.rpc === 'start_pilot');
  assert.equal(started.length, 1);
  assert.deepEqual(started[0].args, { dealership_id: ALPHA });
  // the page redraws the two cards in place
  card = page.elements.get('billing').outerHTML;
  assert.match(card, /Billing <span class="pill good">Free pilot<\/span>/);
  assert.match(card, /The free pilot has started\./);
  assert.match(card, /Free pilot: 30 days left \(ends /);
  assert.doesNotMatch(card, /<button/, 'the pilot never restarts, and Subscribe waits for billing');
  assert.match(page.elements.get('gettingStarted').outerHTML, /<span class="name">Start the free pilot<\/span><span class="pill good">Done<\/span>/);
  assert.equal(page.fetches.filter((f) => f.url.includes('/functions/v1/billing')).length, 0, 'the billing function is never called');
  assert.ok(client.requests.some((r) => r.rpc === 'subscription_state' && r.args.dealership_id === ALPHA), 'the plan comes from the database');
  assert.ok(client.requests.some((r) => r.table === 'subscriptions' && r.eq.some(([c, v]) => c === 'dealership_id' && v === ALPHA)));
});

test('before billing opens: a salesperson sees the plan and nothing to press', async () => {
  const client = fakeClient({
    session: { access_token: 'tok', user: { id: 'u-sam', email: 'sam@example.test' } },
    tables: { ...twoDealerships(), memberships: [{ user_id: 'u-sam', dealership_id: ALPHA, role: 'salesperson', name: 'Sam' }], subscriptions: [] },
    rpcs: { subscription_state: () => ({ data: 'none', error: null }) },
  });
  const html = main(await openPage(PAGE, { client, billing: false }));
  assert.match(billingCardOf(html), /No plan yet\. A manager can start the free pilot: no card\./);
  assert.doesNotMatch(html, /data-action="billing"|id="gettingStarted"/);
});

test('before billing opens: a pilot the owner recorded by agreement shows with its end date, and a lapsed one says whom to ask', async () => {
  const end = new Date(Date.now() + 20.5 * DAY).toISOString();
  const pilot = fakeClient({
    session: ME,
    tables: { ...twoDealerships(), subscriptions: [{ dealership_id: ALPHA, status: 'pilot', pilot_ends_at: end }] },
    rpcs: { subscription_state: () => ({ data: 'pilot', error: null }) },
  });
  const html = main(await openPage(PAGE, { client: pilot, billing: false }));
  assert.match(html, /Billing <span class="pill good">Free pilot<\/span><\/h2><p class="plan">Free pilot: 21 days left \(ends /);
  assert.ok(html.includes(`<p class="hint">${BILLING_CLOSED_NOTE}</p>`), 'whom to ask about what comes after');
  assert.doesNotMatch(html, /data-action="billing"/);
  const lapsed = fakeClient({
    session: ME,
    tables: { ...twoDealerships(), subscriptions: [{ dealership_id: ALPHA, status: 'pilot', pilot_ends_at: new Date(Date.now() - 2 * DAY).toISOString() }] },
    rpcs: { subscription_state: () => ({ data: 'lapsed', error: null }) },
  });
  const lapsedHtml = main(await openPage(PAGE, { client: lapsed, billing: false }));
  assert.match(lapsedHtml, /Billing is not open yet: ask your Lot Current contact\./);
  assert.match(lapsedHtml, /The plan has lapsed, and billing is not open yet: ask your Lot Current contact\./, 'Getting started says the same');
  assert.doesNotMatch(lapsedHtml, /data-action="billing"/, 'nothing to press that would call a function that is not there');
});
