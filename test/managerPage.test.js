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
// select / eq / order / limit / range, answering from `tables` and, like the
// hosted API, at most `maxRows` rows per request whatever the range asks for.
function fakeClient({ session = null, tables = {}, maxRows = 1000, seen = {}, rpcs = {} } = {}) {
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
// comes with Stripe). The page must not call it, show an error for it, or
// send the manager to a card that cannot do the step.
test('before billing opens: no billing route is called, the card says billing is not open yet with nothing to press, and Getting started has no plan step', async () => {
  const client = fakeClient({
    session: ME,
    tables: { ...twoDealerships(), subscriptions: [] },
    rpcs: { subscription_state: () => ({ data: 'none', error: null }) },
  });
  const page = await openPage(PAGE, { client, billing: false });
  assert.equal(page.elements.get('dealer').textContent, 'Alpha Motors');
  assert.equal(page.fetches.filter((f) => f.url.includes('/functions/v1/billing')).length, 0, 'the billing function is never called');
  const html = main(page);
  const billingCardHtml = html.slice(html.indexOf('<section class="card" id="billing">'), html.indexOf('</section>', html.indexOf('id="billing"')));
  assert.match(billingCardHtml, /Billing <span class="pill ">Not open yet<\/span>/);
  assert.match(billingCardHtml, /Billing is not open yet, so there is no plan to start or pay for here, and nothing is charged\./);
  assert.doesNotMatch(billingCardHtml, /Couldn&#39;t read the plan|Couldn't read the plan|<button/, 'no error and no button');
  assert.doesNotMatch(html, /Start the free pilot or subscribe|Go to Billing/, 'Getting started leaves the plan step out');
  assert.match(html, /Getting started <span class="pill ">1 of 3 done<\/span>/);
  assert.ok(client.requests.some((r) => r.rpc === 'subscription_state' && r.args.dealership_id === ALPHA), 'the plan comes from the database');
  assert.ok(client.requests.some((r) => r.table === 'subscriptions' && r.eq.some(([c, v]) => c === 'dealership_id' && v === ALPHA)));
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
  assert.doesNotMatch(html, /data-action="billing"/);
  const lapsed = fakeClient({
    session: ME,
    tables: { ...twoDealerships(), subscriptions: [{ dealership_id: ALPHA, status: 'pilot', pilot_ends_at: new Date(Date.now() - 2 * DAY).toISOString() }] },
    rpcs: { subscription_state: () => ({ data: 'lapsed', error: null }) },
  });
  const lapsedHtml = main(await openPage(PAGE, { client: lapsed, billing: false }));
  assert.match(lapsedHtml, /Billing is not open yet: ask your Lot Current contact\./);
  assert.doesNotMatch(lapsedHtml, /data-action="billing"/, 'nothing to press that would call a function that is not there');
});
