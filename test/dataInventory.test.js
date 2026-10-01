// docs/data-inventory.md lists everything Lot Current stores or sends, read
// from the code, and the privacy texts are checked against it. These tests
// keep the page true as the code grows: each fails when the code gains
// something the page does not name (a chrome.storage key or area, a table or
// a column, an Edge Function, an outside host, a field sent to the rewrite
// service, a file the extension or the manager view saves), when a table's
// API access in the migrations differs from what the page, supabase/README.md
// or the functions' auth.ts header says of it, when the page names something
// the code no longer has, and when a recipient the page names is missing from
// a privacy text that must name it. The privacy policy is also held to what
// the sync sends of a rescan and to what Download photos keeps.
// The pending marks in those texts must each point at a question that exists
// in legal/questions-for-attorney.md, and every question there must be
// waited on somewhere, so an answered question cannot leave a stale mark.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_KEY_NAMES, GLOBAL_KEYS } from '../extension/src/storageKeys.js';
import { PROFILE_KEY } from '../extension/src/settings.js';
import { generateDescription, guessColorsWithBackend } from '../extension/src/rewriter.js';
import { syncPayload } from '../extension/src/sync.js';
import { noteFlags } from '../extension/src/pilot.js';
import { neededPatterns } from '../extension/src/photoHosts.js';
import schemaOrg from '../extension/adapters/schemaOrg.js';
import { SITE } from '../site/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
// The website's own host once siteUrl is set: the pages name it in their
// canonical and share addresses, and it is this site, not an outside host.
const SITE_HOST = SITE.siteUrl ? new URL(SITE.siteUrl).hostname : null;
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const inventory = read('docs/data-inventory.md');
const policy = read('legal/privacy-policy.md');
const storeTexts = read('legal/chrome-web-store-privacy.md');
const questions = read('legal/questions-for-attorney.md');
const sorted = (xs) => [...new Set(xs)].sort();

// The same comment stripper as test/anyDealer.test.js: whole-line and
// trailing // comments (never the // of an address) and block comments.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/[^\n]*$/gm, '$1');
const stripHtmlComments = (src) => src.replace(/<!--[\s\S]*?-->/g, '');

function walk(dir, out = []) {
  for (const name of readdirSync(join(root, dir))) {
    const rel = dir + '/' + name;
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

// The code that ships: the extension, the manager view, the website and the
// Edge Functions (backend/ talks to Anthropic through its SDK and names no host).
// manager/vendor/ is left out: it is supabase-js's own build, served next to
// the page instead of from a CDN, unchanged and pinned by its hash
// (test/manager.test.js). Its text names hosts in error messages it never
// contacts and storage of features the page does not use; what it does for
// the page (the session in localStorage, the calls to the project) is in the
// manager view's rows, as it was when a CDN served it.
const VENDORED = /^manager\/vendor\//;
const SHIPPED = [...walk('extension'), ...walk('manager'), ...walk('site'), ...walk('supabase/functions'), ...walk('backend')]
  .filter((f) => /\.(js|mjs|ts|html)$/.test(f) || f === 'extension/manifest.json')
  .filter((f) => !/package(-lock)?\.json$/.test(f))
  .filter((f) => !VENDORED.test(f));
const source = (f) => (/\.html$/.test(f) ? stripHtmlComments(read(f)) : /\.json$/.test(f) ? read(f) : stripComments(read(f)));

// The text from a heading to the next heading of the same or a higher level.
function section(text, heading) {
  const start = text.indexOf('\n' + heading + '\n');
  assert.ok(start >= 0, `no "${heading}" heading`);
  const level = heading.match(/^#+/)[0].length;
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`^#{1,${level}} `, 'm'));
  return next >= 0 ? rest.slice(0, next) : rest;
}

// Every markdown table in a text, as { header, rows } of trimmed cells.
function tables(text) {
  const out = [];
  let lines = [];
  const flush = () => {
    if (lines.length >= 2) {
      const cells = (l) => l.trim().slice(1, -1).split('|').map((c) => c.trim());
      out.push({ header: cells(lines[0]), rows: lines.slice(2).map(cells) });
    }
    lines = [];
  };
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('|')) lines.push(line);
    else flush();
  }
  flush();
  return out;
}

const onlyTable = (text, where) => {
  const t = tables(text);
  assert.equal(t.length, 1, `${where} should hold one table`);
  return t[0];
};
const firstCode = (cell) => (cell.match(/^`([^`]+)`/) || [])[1];
const column = (table, name) => {
  const i = table.header.indexOf(name);
  assert.ok(i >= 0, `a table has no "${name}" column: ${table.header.join(' | ')}`);
  return i;
};

// ---------- the browser ----------

test('every chrome.storage key the extension uses has a row, and every row is a key the code has', () => {
  const perSite = onlyTable(section(inventory, '### `chrome.storage.local`, per dealer website'), 'the per-website section');
  assert.deepEqual(sorted(perSite.rows.map((r) => firstCode(r[0]))), sorted(Object.values(SITE_KEY_NAMES).map((n) => `${n}:<origin>`)), 'the per-website rows are not the keys of SITE_KEY_NAMES (src/storageKeys.js)');
  const global = onlyTable(section(inventory, '### `chrome.storage.local`, one per browser'), 'the one-per-browser section');
  assert.deepEqual(sorted(global.rows.map((r) => firstCode(r[0]))), sorted(Object.values(GLOBAL_KEYS)), 'the one-per-browser rows are not the keys of GLOBAL_KEYS (src/storageKeys.js)');
  const synced = onlyTable(section(inventory, '### `chrome.storage.sync`'), 'the sync section');
  assert.deepEqual(synced.rows.map((r) => firstCode(r[0])), [PROFILE_KEY], 'the sync rows are not PROFILE_KEY (src/settings.js)');
  for (const t of [perSite, global, synced]) {
    const fields = column(t, 'Fields');
    for (const r of t.rows) assert.ok(r[fields].length > 20, `${r[0]} has no fields written down`);
  }
});

test('every chrome.storage area the extension touches has its own section', () => {
  const areas = new Set();
  for (const f of SHIPPED.filter((x) => x.startsWith('extension/') && x.endsWith('.js'))) {
    for (const m of source(f).matchAll(/chrome\.storage\.(\w+)/g)) if (m[1] !== 'onChanged') areas.add(m[1]);
  }
  assert.ok(areas.has('local') && areas.has('sync'), 'the scan no longer finds the two areas: fix this test');
  const documented = new Set([...inventory.matchAll(/^### `chrome\.storage\.(\w+)`/gm)].map((m) => m[1]));
  assert.deepEqual(sorted(areas), sorted(documented), 'the areas the code uses are not the areas docs/data-inventory.md has a section for');
});

test('the extension, the manager view and the website keep nothing in the browser beyond what the inventory lists', () => {
  // the inventory says so in these words; the scan below holds it to them
  assert.ok(inventory.includes('The extension uses no cookies, no `localStorage`, no `sessionStorage` and no IndexedDB of its own'));
  assert.ok(inventory.includes("The page writes no cookie and nothing to web storage itself; the only browser storage is supabase-js's session above."));
  assert.ok(inventory.includes('No cookies, no web storage, no analytics, and nothing loaded from another host'));
  for (const f of SHIPPED.filter((x) => /^(extension|manager|site)\//.test(x))) {
    const hit = source(f).match(/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|document\.cookie/);
    assert.equal(hit, null, `${f} uses ${hit && hit[0]}: add it to docs/data-inventory.md and the privacy policy, then change this test`);
  }
  for (const f of SHIPPED.filter((x) => x.startsWith('site/') && x.endsWith('.html'))) {
    // A canonical link names the page's own address on the site's own host;
    // the browser loads nothing from it.
    const hits = [...source(f).matchAll(/<(script|link|img|iframe)\b[^>]*\b(src|href)="((?:https?:)?\/\/[^"]*)"/gi)]
      .filter((m) => !(/^<link\s+rel="canonical"/i.test(m[0]) && SITE_HOST && new URL(m[3], 'https://x').hostname === SITE_HOST))
      .map((m) => m[0]);
    assert.deepEqual(hits, [], `${f} loads ${hits[0]} from another host: the inventory says the website loads nothing from elsewhere`);
  }
  const css = read('site/site.css');
  assert.doesNotMatch(css, /@import|url\(\s*['"]?(https?:)?\/\//i, 'site/site.css loads something from another host');
});

// ---------- the database ----------

const MIGRATIONS = readdirSync(join(root, 'supabase/migrations')).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
// { table: [columns] } from every create table and add column in the migrations
function schema() {
  const out = {};
  for (const f of MIGRATIONS) {
    const sql = read('supabase/migrations/' + f);
    for (const m of sql.matchAll(/^create table public\.(\w+) \(([^]*?)\n\);/gm)) {
      out[m[1]] = m[2].split('\n').map((l) => l.trim()).filter((l) => l && !/^(--|constraint\b|unique\b|primary key\b|check\b|foreign key\b)/i.test(l)).map((l) => l.match(/^(\w+)\s/)[1]);
    }
    for (const m of sql.matchAll(/^alter table (?:only )?public\.(\w+)\s+add column (?:if not exists )?(\w+)/gim)) (out[m[1]] = out[m[1]] || []).push(m[2]);
  }
  return out;
}

test('every table the migrations create has a row, with every column, and every row is a table', () => {
  const tablesInCode = schema();
  assert.ok(Object.keys(tablesInCode).length >= 14, Object.keys(tablesInCode).join(', '));
  const t = onlyTable(section(inventory, '### Tables'), 'the database section');
  const rows = Object.fromEntries(t.rows.map((r) => [firstCode(r[0]), r]));
  assert.deepEqual(sorted(Object.keys(rows)), sorted(Object.keys(tablesInCode)), 'the rows under "### Tables" are not the tables of supabase/migrations/*.sql');
  const fields = column(t, 'Fields');
  for (const [name, columns] of Object.entries(tablesInCode)) {
    for (const c of columns) assert.ok(rows[name][fields].includes('`' + c + '`'), `docs/data-inventory.md: ${name} does not name its column ${c}`);
    for (const c of ['Why', 'Who can read it through the API', 'How long; how deleted']) assert.ok(rows[name][column(t, c)].length > 10, `${name} has no "${c}"`);
  }
});

// The tables and views a caller's token can read through the API: each
// table-level grant of select (or all) to anon, authenticated or public, less
// what a later revoke takes back, in migration order. Column grants of other
// rights (update (name)) and grants to service_role do not count.
function apiReadable() {
  const pairs = new Set();
  const created = [];
  for (const f of MIGRATIONS) {
    const sql = read('supabase/migrations/' + f);
    created.push(...[...sql.matchAll(/^create table public\.(\w+) \(/gm)].map((m) => m[1]));
    for (const m of sql.matchAll(/^(grant|revoke) ([^;]+?) on (?!function\b|sequence\b|schema\b|all sequences\b)(?:table )?(all tables in schema public|public\.\w+(?:, public\.\w+)*) (?:to|from) ([^;]+);/gm)) {
      if (!/\b(select|all)\b/.test(m[2])) continue;
      const targets = m[3] === 'all tables in schema public' ? [...created] : m[3].split(/,\s*/).map((t) => t.replace(/^public\./, ''));
      const roles = m[4].split(/,\s*/).flatMap((r) => (r === 'public' ? ['anon', 'authenticated'] : [r])).filter((r) => r === 'anon' || r === 'authenticated');
      for (const t of targets) for (const r of roles) pairs[m[1] === 'grant' ? 'add' : 'delete'](`${t}/${r}`);
    }
  }
  return new Set([...pairs].map((p) => p.split('/')[0]));
}

test('"Who can read it through the API" says "No API" exactly for the tables no caller\'s token may read', () => {
  const readable = apiReadable();
  assert.ok(readable.has('listings') && readable.size < Object.keys(schema()).length, 'the grant scan no longer finds the grants and the revokes: fix this test');
  const t = onlyTable(section(inventory, '### Tables'), 'the database section');
  const who = column(t, 'Who can read it through the API');
  for (const r of t.rows) {
    const name = firstCode(r[0]);
    assert.equal(!/^No API\b/.test(r[who]), readable.has(name), `${name}: the migrations ${readable.has(name) ? 'grant' : 'grant no'} API read, and the inventory says "${r[who].slice(0, 40)}"`);
  }
});

test('supabase/README.md and the auth.ts header name every table the functions reach with the service-role key, and which of them a member may still read', () => {
  const readable = apiReadable();
  const used = new Set();
  for (const f of walk('supabase/functions').filter((x) => /\.(ts|mjs|js)$/.test(x))) {
    for (const m of source(f).matchAll(/\b(?:service|serviceClient\(\))\.from\('(\w+)'\)/g)) used.add(m[1]);
  }
  assert.ok(used.has('rewrite_usage') && used.has('demo_requests') && used.has('billing_events'), 'the scan no longer finds the service-role reads and writes: fix this test');
  const cell = read('supabase/README.md').split('\n').find((l) => l.startsWith('| `SUPABASE_URL`, '));
  assert.ok(cell, 'supabase/README.md has no SUPABASE_URL row');
  const header = read('supabase/functions/_shared/auth.ts').split('\nimport ')[0].replace(/^\/\/ ?/gm, '').replace(/\s+/g, ' ');
  const named = (text) => sorted((text.match(/\b\w+\b/g) || []).filter((w) => used.has(w)));
  for (const [where, text] of [['supabase/README.md', cell], ['supabase/functions/_shared/auth.ts', header]]) {
    assert.doesNotMatch(text, /no API role may touch/i, `${where}: members read some of these tables through the API`);
    for (const t of used) assert.match(text, new RegExp(`\\b${t}\\b`), `${where} does not name ${t}, which the functions reach with the service-role key`);
    const members = text.match(/a member may still read their own dealership's rows of ([^;.]+)/);
    const nobody = text.match(/no caller's token reaches ([^;.]+) at all/);
    assert.ok(members && nobody, `${where} no longer says which of these tables a member may read and which no caller may`);
    assert.deepEqual(named(members[1]), sorted([...used].filter((t) => readable.has(t))), `${where}: the tables a member may read are not the ones the migrations grant`);
    assert.deepEqual(named(nobody[1]), sorted([...used].filter((t) => !readable.has(t))), `${where}: the tables no caller may read are not the ones the migrations keep closed`);
  }
});

test('every view the migrations create is named in the database section', () => {
  const db = section(inventory, "## Lot Current's database (Supabase)");
  const views = MIGRATIONS.flatMap((f) => [...read('supabase/migrations/' + f).matchAll(/^create (?:or replace )?view public\.(\w+)/gm)].map((m) => m[1]));
  assert.ok(views.length >= 2);
  for (const v of views) assert.ok(db.includes('`' + v + '`'), `docs/data-inventory.md does not name the view ${v}`);
});

// ---------- the Edge Functions ----------

test('every Edge Function has a row, and its log column says whether it logs every call', () => {
  const dirs = readdirSync(join(root, 'supabase/functions')).filter((d) => !d.startsWith('_') && statSync(join(root, 'supabase/functions', d)).isDirectory());
  assert.ok(dirs.length >= 4, dirs.join(', '));
  const t = onlyTable(section(inventory, '## What each Edge Function receives, keeps and logs'), 'the Edge Function section');
  const rows = Object.fromEntries(t.rows.map((r) => [firstCode(r[0]), r]));
  assert.deepEqual(sorted(Object.keys(rows)), sorted(dirs), 'the rows are not the directories of supabase/functions (without _shared)');
  const logs = column(t, 'Logs');
  for (const d of dirs) {
    const code = walk('supabase/functions/' + d).filter((f) => /\.(ts|mjs|js)$/.test(f)).map(source).join('\n');
    // console.log is a line per call; console.error only on a failure
    const everyCall = /console\.log\(/.test(code);
    const onlyFailures = /^Only\b/.test(rows[d][logs]);
    assert.equal(onlyFailures, !everyCall, `${d}: the code ${everyCall ? 'logs routine calls' : 'logs only failures'}, and the Logs column says otherwise: "${rows[d][logs].slice(0, 60)}"`);
  }
});

// ---------- what leaves the browser ----------

test('every outside host the shipped code names is listed, and every host listed is still in the code', () => {
  const hosts = new Set();
  for (const f of SHIPPED) {
    const text = source(f).replace(/\\+\./g, '.'); // a host spelled inside a regular expression
    for (const m of text.matchAll(/https?:\/\/([a-z0-9*][a-z0-9*.-]*)/gi)) {
      const host = m[1].toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
      if (!host.includes('.') || /^[\d.]+$/.test(host)) continue; // a bare pattern, localhost, an address
      if (/\.(example|test|invalid|localhost)$/.test(host) || /(^|\.)example\.(com|org|net)$/.test(host)) continue; // placeholders
      if (f.startsWith('site/') && host === SITE_HOST) continue; // the website's own address, in its canonical and share tags; anything else that calls it must be listed
      hosts.add(host);
    }
  }
  assert.ok(hosts.has('api.anthropic.com') && hosts.has('www.facebook.com'), 'the scan no longer finds the known hosts: fix this test');
  const at = inventory.indexOf('The outside hosts the shipped code names');
  assert.ok(at >= 0, 'docs/data-inventory.md has no list of outside hosts');
  const listed = [...inventory.slice(at, inventory.indexOf('\n', at)).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  assert.deepEqual(sorted(listed), sorted(hosts), 'the outside hosts in the code are not the ones docs/data-inventory.md lists');
});

// A made-up car with every field the website can give, the VIN and the price included.
const CAR = {
  vin: '1C4RJFBG5KC000001', year: 2019, make: 'Jeep', model: 'Grand Cherokee', trim: 'Limited', mileage: 41210, stock: 'P1001', price: 25990,
  features: ['Heated seats', 'Backup camera'], carfaxOneOwner: true, carfaxUrl: 'https://www.carfax.test/x', exteriorColor: 'Gray', interiorColor: 'Black',
  bodyType: 'SUV', engine: '3.6L V6', transmission: 'Automatic', drivetrain: '4WD', fuelType: 'Gasoline', descriptionRaw: 'Clean and ready. One owner.', photos: ['https://images.test/1.jpg'],
};

async function sentToRewrite() {
  let body = null;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ ok: true, text: '' }) };
  };
  await generateDescription({
    vehicle: CAR, dealer: { name: 'Example Motors', city: 'Springfield', state: 'OH', zip: '43215' }, salesperson: { name: 'Pat', title: 'sales consultant', closingLine: 'Ask for Pat by name.' },
    priceNote: 'Tax and tags extra.', price: 25990, settings: { rewrite: { enabled: true, endpoint: 'https://rewrite.test', key: 'k' } }, origin: 'https://www.example-motors.test', fetchImpl,
    highlights: [], // a pick made, so every field that can be sent is
  });
  assert.ok(body, 'generateDescription did not call the rewrite service');
  return body;
}

test('the rewrite service gets exactly the fields "Exactly what reaches Anthropic" lists, and never a VIN or a price field', async () => {
  const body = await sentToRewrite();
  assert.equal(body.origin, 'https://www.example-motors.test', 'the origin goes with the facts');
  assert.ok(read('supabase/functions/rewrite/index.ts').includes('delete facts.origin;'), 'the rewrite function no longer removes origin before the facts reach Anthropic: update the inventory');
  // the self-hosted backend/ takes the same body, so it must drop origin too
  const server = stripComments(read('backend/server.js'));
  const strip = server.indexOf('delete facts.origin;');
  assert.ok(strip > 0 && strip < server.indexOf('await rewrite(facts)'), 'backend/server.js no longer removes origin before the facts reach Anthropic: update the inventory and the privacy policy');
  const t = tables(section(inventory, '## What leaves the browser'))[0];
  const row = t.rows.find((r) => r[0].startsWith('Description writer'));
  assert.ok(row && row[column(t, 'What is sent')].includes('`origin`'), 'the Description writer row does not name origin');
  const sent = [];
  for (const [k, v] of Object.entries(body)) {
    if (k === 'origin') continue;
    sent.push(k);
    if (v && typeof v === 'object' && !Array.isArray(v)) sent.push(...Object.keys(v));
  }
  for (const k of sent) assert.doesNotMatch(k, /^(vin|price)$/i, `the rewrite request carries a ${k} field`);
  const part = section(inventory, '### Exactly what reaches Anthropic');
  const bullets = part.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(bullets.length >= 4);
  const listed = bullets.flatMap((l) => [...l.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
  assert.deepEqual(sorted(listed), sorted(sent), 'the fields the extension sends are not the fields docs/data-inventory.md lists');
});

test('a colour guess sends the photo addresses, the colour words and the origin, nothing else; Anthropic gets the first two', async () => {
  let body = null;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ ok: true, exterior: 'Gray' }) };
  };
  await guessColorsWithBackend({ endpoint: 'https://rewrite.test', photos: CAR.photos, options: ['Gray', 'Black'], origin: 'https://www.example-motors.test', fetchImpl });
  assert.deepEqual(Object.keys(body).sort(), ['options', 'origin', 'photos'], 'the colour guess sends something new: update the Colour guess row and "Exactly what reaches Anthropic"');
  assert.match(section(inventory, '### Exactly what reaches Anthropic'), /up to four photo addresses[^.]*and the list of colour words\. Nothing else\./);
  // the network row names every key the extension sends
  const t = tables(section(inventory, '## What leaves the browser'))[0];
  const row = t.rows.find((r) => r[0].startsWith('Colour guess'));
  assert.ok(row, 'the network table has no Colour guess row');
  const sent = row[column(t, 'What is sent')];
  for (const k of Object.keys(body)) assert.ok(sent.includes('`' + k + '`'), `the colour guess sends ${k}, and the Colour guess row does not name it`);
  // and so does the Web Store answer for the rewrite service, in words
  const store = onlyTable(section(storeTexts, '## What the extension sends, and to whom (mirrors `docs/data-inventory.md`)'), 'the Web Store sends section');
  const rewrite = store.rows.find((r) => /rewrite service/.test(r[column(store, 'To')]));
  assert.ok(rewrite, 'the Web Store answers have no row for the rewrite service');
  const what = rewrite[column(store, 'What')];
  assert.match(what, /for a colour guess, up to four photo addresses and the list of colour words/);
  assert.match(what, /the dealership's website address/, 'the description writer and the colour guess send the website address, and the Web Store answers do not say so');
  // and the help a salesperson reads
  const help = read('docs/help.md');
  assert.match(help, /for a colour guess, up to four photo addresses and the list of colour words, sent to the rewrite service with your dealership website's address/, 'docs/help.md: what leaves the browser for a draft or a colour guess');
});

test('the sync row names every part of the sync payload', () => {
  const body = syncPayload({ origin: 'https://www.example-motors.test', posted: {}, pilot: null, scan: null, since: null, userId: 'u' });
  const t = tables(section(inventory, '## What leaves the browser'))[0];
  const row = t.rows.find((r) => r[0].startsWith('Sync '));
  assert.ok(row, 'the network table has no Sync row');
  const sent = row[column(t, 'What is sent')];
  for (const k of Object.keys(body)) assert.ok(sent.includes('`' + k + '`'), `the sync payload carries ${k}, and the Sync row does not name it`);
});

test('the privacy texts say the take-downs and price changes on the person\'s own listings leave the browser as to-do items, with both prices', () => {
  const [MINE, REPRICED, THEIRS] = ['1C4RJFBG5KC000001', '1C4RJFBG5KC000002', '1C4RJFBG5KC000003'];
  const diff = {
    takeDown: [{ vin: MINE, name: '2019 Jeep Grand Cherokee', why: 'sold', yours: true }, { vin: THEIRS, name: '2020 Ram 1500', why: 'sold', yours: false }],
    priceUpdates: [{ vin: REPRICED, name: '2018 Jeep Wrangler', from: 25990, to: 24990, yours: true }],
  };
  const pilot = noteFlags(null, diff, { at: '2026-09-01T12:00:00.000Z' });
  const up = syncPayload({ origin: 'https://www.example-motors.test', posted: {}, pilot, scan: null, since: null, userId: 'u' }).pilot.flags;
  assert.deepEqual(up.map((f) => f.vin).sort(), [MINE, REPRICED].sort(), 'the person\'s own take-downs and price changes go up, a colleague\'s do not');
  const price = up.find((f) => f.kind === 'price');
  assert.deepEqual([price.name, price.from, price.to], ['2018 Jeep Wrangler', 25990, 24990], 'a price change goes up with the car\'s name and both prices');
  const todo = schema().todo_items;
  assert.ok(todo.includes('from_price') && todo.includes('to_price'), 'todo_items keeps both prices');
  const t = tables(section(policy, '## What we collect and why'))[0];
  const row = (label) => t.rows.find((r) => r[0].startsWith(label));
  const scans = row('Scan results')[1];
  assert.match(scans, /except the cars to take down and the price changes on the User's own listings, which become to-do items/, 'the policy says the lists of changes all stay in the browser');
  assert.doesNotMatch(scans, /gets only/);
  assert.match(row('Usage numbers')[0], /to-do items \([^)]*VIN and name[^)]*old and new price\)/, 'the policy\'s Usage numbers row does not say the to-do items carry the VIN, the name and both prices');
  const usage = onlyTable(section(storeTexts, '## Usage numbers (mirrors the Privacy Policy)'), 'the Web Store usage section');
  assert.match(usage.rows[0][0], /to-do items \([^)]*VIN and name[^)]*old and new price\)/, 'the Web Store usage row does not mirror the policy');
});

test('every file the extension or the manager view saves is listed where that part\'s files are, and the policy says the photos can be kept', () => {
  const where = { extension: section(inventory, '### Files and the clipboard'), manager: section(inventory, '## The manager view (`manager/`)') };
  const saves = [];
  for (const f of SHIPPED.filter((x) => /^(extension|manager)\/.*\.js$/.test(x))) {
    const src = source(f);
    for (const m of src.matchAll(/\.download\s*=(?!=)|chrome\.downloads\./g)) {
      // the function or the click case the save happens in names it
      const names = [...src.slice(0, m.index).matchAll(/function\s+(\w+)\s*\(|case\s+'(\w+)'\s*:/g)];
      const last = names[names.length - 1];
      const name = last && (last[1] || last[2]);
      assert.ok(name, `${f} saves a file outside any named function or click case`);
      assert.ok(where[f.split('/')[0]].includes('`' + name + '`'), `${f} saves a file in ${name}, and docs/data-inventory.md does not name it with that part's files`);
      saves.push(name);
    }
  }
  assert.ok(['pilotCsv', 'downloadPhotos', 'downloadCsv'].every((n) => saves.includes(n)), `the scan no longer finds the known saves (${saves.join(', ')}): fix this test`);
  const t = tables(section(inventory, '## What leaves the browser'))[0];
  const photos = t.rows.find((r) => r[0].startsWith('Photos '));
  assert.match(photos[column(t, 'Kept afterwards')], /\*\*Download photos\*\* saves/, 'the Photos row says nothing is kept');
  assert.match(policy, /photos themselves[^|]*not kept, unless the User clicks Download photos, which saves them as files in the User's Downloads folder/, 'the privacy policy says the photos are never kept');
});

// Round J's adapter reads plain pages where Dealer Inspire calls a keyed
// search, and its photos can sit on any https server the markup names; the
// requests table once described only Dealer Inspire and sent every photo to
// "the dealership's website".
test('the requests table names each adapter\'s own requests, with the key only where one is sent', async () => {
  const t = tables(section(inventory, '## What leaves the browser'))[0];
  const what = column(t, 'What is sent');
  const row = (start) => {
    const r = t.rows.find((x) => x[0].startsWith(start));
    assert.ok(r, `the requests table has no "${start}" row`);
    return r[what];
  };
  const scan = row('Scan ');
  const record = row("The car's full record ");
  const adapters = [...read('extension/adapters/index.js').matchAll(/^import \w+ from '\.\/(\w+\.js)';/gm)].map((m) => m[1]);
  assert.ok(adapters.includes('dealerInspire.js') && adapters.includes('schemaOrg.js'), 'adapters/index.js no longer imports the known adapters: fix this test');
  for (const file of adapters) {
    for (const [name, cell] of [['Scan', scan], ["car's full record", record]]) {
      assert.ok(cell.includes('`adapters/' + file + '`'), `the ${name} row does not say what adapters/${file} sends`);
    }
    if (/robots\.txt/.test(stripComments(read('extension/adapters/' + file)))) {
      assert.ok(scan.includes('`/robots.txt`') && /sitemaps?\b/.test(scan), `adapters/${file} reads robots.txt and sitemaps, and the Scan row does not say so`);
    }
  }
  // what the standard-data adapter's background read actually sends
  let init = null;
  const direct = schemaOrg.makeDirectSearch({ kind: 'schemaOrg', origin: 'https://www.example-motors.test' }, async (url, i) => {
    init = i;
    return { ok: true, status: 200, url, headers: { get: () => 'text/html' }, text: async () => '' };
  });
  await direct({ url: 'https://www.example-motors.test/used/' });
  assert.equal(init.credentials, 'omit', 'the standard-data background read sends cookies now: update the inventory');
  assert.equal(init.headers, undefined, 'the standard-data background read sends headers of its own now: update the inventory');
  assert.match(scan, /with no key/, 'the Scan row says every scan carries a key');
  assert.match(row('Background rescan '), /without cookies/, 'the Background rescan row does not say the standard-data reads go without cookies');
  const site = onlyTable(section(inventory, '## Who receives data'), 'the recipients section').rows.find((r) => r[0] === "The dealership's website");
  assert.ok(site, 'no "The dealership\'s website" recipient');
  assert.match(site.join(' | '), /no key/, 'the recipients list says every request to the dealership\'s website carries its public key');
});

test('the photos go to whatever https server the website names, and the inventory and the privacy texts say so', () => {
  // the code: a photo on another company's server is asked for, not refused
  assert.deepEqual(neededPatterns(['https://photos.vendor-cdn.test/car/1.jpg'], { manifestHosts: [], granted: [] }), ['https://photos.vendor-cdn.test/*'], 'photoHosts.js no longer asks for any https photo server: update the inventory and the privacy texts');
  const t = tables(section(inventory, '## What leaves the browser'))[0];
  const photos = t.rows.find((r) => r[0].startsWith('Photos '));
  assert.equal(photos[column(t, 'Recipient')], 'Photo servers', 'the Photos row does not send the photos to the servers the website names');
  const list = onlyTable(section(inventory, '## Who receives data'), 'the recipients section');
  const cells = (name) => list.rows.find((r) => r[0] === name).join(' | ');
  assert.match(cells('Photo servers'), /the servers the dealership's website names[^|]*another company's[^|]*Chrome's own prompt/, 'the Photo servers row does not say any server the website names, asked for in Chrome');
  assert.doesNotMatch(cells("The dealership's website"), /image host|photo/i, 'the dealership\'s website is still named as where the photos go');
  assert.doesNotMatch(inventory, /the dealership's image host/, 'the inventory still sends photos (or Anthropic) to "the dealership\'s image host"');
  // the Web Store answers: the photos row says when and to whom
  const sends = onlyTable(section(storeTexts, '## What the extension sends, and to whom (mirrors `docs/data-inventory.md`)'), 'the Web Store sends section');
  const [when, whatCol, to] = ['When', 'What', 'To'].map((c) => column(sends, c));
  const photoRows = sends.rows.filter((r) => /\bphotos\b/.test(r[whatCol]) && !/photo addresses/.test(r[whatCol]));
  assert.equal(photoRows.length, 1, 'the Web Store answers should send the photos in one row of their own');
  assert.match(photoRows[0][when], /Download photos/, 'the Web Store answers say the photos go with each scan');
  assert.doesNotMatch(photoRows[0][when], /scan/i, 'the Web Store answers say the photos go with each scan');
  assert.match(photoRows[0][to], /photo servers the dealership's website names[^|]*another company[^|]*Chrome's own prompt, from the user's click/, 'the Web Store answers do not say the photos go to any server the website names, asked for from the click');
  for (const r of sends.rows) assert.doesNotMatch(r[to], /image host/, 'a Web Store answer still names "the image host" as a recipient');
  // the privacy policy's services that are not processors
  const others = policy.split('\n').find((l) => l.startsWith('Lot Current also reaches services that are not our processors'));
  assert.ok(others, 'the privacy policy no longer names the services that are not processors');
  assert.match(others, /photo servers the dealership's website names[^;]*another company[^;]*Download photos[^;]*Chrome's own prompt/, 'the privacy policy does not say the photos come from any server the website names, from the User\'s click');
  assert.doesNotMatch(others, /image host/, 'the privacy policy still names one image host');
});

// ---------- who receives it, and the privacy texts ----------

function recipients() {
  const t = onlyTable(section(inventory, '## Who receives data'), 'the recipients section');
  const [name, role, named] = ['Recipient', 'Role', 'Named in'].map((c) => column(t, c));
  return t.rows.map((r) => ({ name: r[name], processor: /^processor\b/.test(r[role]), namedIn: [...r[named].matchAll(/`([^`]+)`/g)].map((m) => m[1]) }));
}

test('every recipient is named in the texts the inventory says, and the privacy policy lists every processor', () => {
  const all = recipients();
  assert.ok(all.length >= 5);
  const processors = section(policy, '## Processors');
  const bullets = [...processors.matchAll(/^- \*\*([^*]+)\*\*/gm)].map((m) => m[1]);
  for (const r of all) {
    assert.ok(r.namedIn.includes('legal/privacy-policy.md'), `${r.name}: every recipient is named in the privacy policy`);
    for (const f of r.namedIn) assert.ok(read(f).toLowerCase().includes(r.name.toLowerCase()), `${f} does not name ${r.name}`);
    if (r.processor) assert.ok(bullets.includes(r.name), `the privacy policy's Processors section has no "- **${r.name}**" line`);
  }
  for (const b of bullets) assert.ok(all.some((r) => r.processor && r.name === b), `the privacy policy lists ${b} as a processor, and docs/data-inventory.md does not`);
});

// docs/production-setup.md chose one company per job: GitHub Pages for the
// website, Cloudflare Pages for the manager view, Resend to send sign-in
// email, and the domain's own mailbox for people writing in. One bracket
// for two jobs ("sends the sign-in emails ... and holds our inbox") takes
// one name when it is filled, and leaves the other company unlisted.
test('the processors that host and send mail get one bracket per job, as docs/production-setup.md chose them', () => {
  const setup = read('docs/production-setup.md');
  assert.match(setup, /\| Sign-in email sender \| \*\*Resend\*\*/, 'production-setup.md changed the sign-in sender: update the inventory and this test');
  assert.match(setup, /\| Manager view host \| \*\*Cloudflare Pages\*\*/, 'production-setup.md changed the manager view host: update the inventory and this test');
  assert.match(setup, /Keep the mailbox for people writing to you/, 'production-setup.md no longer keeps a separate inbox: update the inventory and this test');
  assert.doesNotMatch(inventory, /not decided yet/, 'the inventory says the manager view\'s host is undecided');
  const bullets = [...section(policy, '## Processors').matchAll(/^- \*\*([^*]+)\*\*: (.*)$/gm)].map((m) => [m[1], m[2]]);
  const names = bullets.map(([n]) => n);
  for (const n of ['[website host]', '[manager view host]', '[sign-in email sender]', '[inbox provider]']) assert.ok(names.includes(n), `the privacy policy has no "- **${n}**" processor`);
  for (const [n, says] of bullets) {
    assert.ok(!(/sends the sign-in emails/.test(says) && /inbox/.test(says)), `${n} both sends the sign-in emails and holds the inbox`);
    assert.ok(!(/our website/.test(says) && /manager view/.test(says)), `${n} serves both the website and the manager view`);
  }
  const list = onlyTable(section(inventory, '## Who receives data'), 'the recipients section');
  const cells = (name) => (list.rows.find((r) => r[0] === name) || []).join(' | ');
  assert.match(cells('[website host]'), /GitHub/);
  assert.match(cells('[manager view host]'), /Cloudflare/);
  assert.match(cells('[sign-in email sender]'), /Resend/);
  assert.match(cells('[inbox provider]'), /support inbox/);
});

test('every Recipient cell names a recipient of the list, and every recipient receives something', () => {
  const names = new Set(recipients().map((r) => r.name));
  const used = new Set();
  for (const t of tables(inventory)) {
    const i = t.header.indexOf('Recipient');
    if (i < 0 || t.header[0] === 'Recipient') continue; // the list itself
    for (const r of t.rows) {
      for (const n of r[i].split(/,\s*/)) {
        if (n === 'none') continue;
        assert.ok(names.has(n), `"${n}" (in the row "${r[0].slice(0, 40)}") is not a recipient under "## Who receives data"`);
        used.add(n);
      }
    }
  }
  for (const n of names) assert.ok(used.has(n), `${n} is listed under "## Who receives data" but no row sends it anything`);
});

const PENDING = /\[Pending attorney answer: questions-for-attorney\.md (\d+\.\d+)\]/g;
const PRIVACY_TEXTS = ['legal/privacy-policy.md', 'legal/chrome-web-store-privacy.md', 'store/listing.md', 'docs/data-inventory.md'];

test('every pending mark names a question that exists, and every privacy question is waited on', () => {
  const asked = [...section(questions, '## 8. Privacy: what the data inventory could not settle').matchAll(/^- \*\*(\d+\.\d+)\*\*/gm)].map((m) => m[1]);
  assert.ok(asked.length >= 4, 'questions-for-attorney.md section 8 lost its questions');
  const marked = new Set();
  for (const f of PRIVACY_TEXTS) {
    for (const m of read(f).matchAll(PENDING)) {
      assert.ok(asked.includes(m[1]), `${f} waits for question ${m[1]}, which questions-for-attorney.md section 8 does not ask`);
      marked.add(m[1]);
    }
  }
  for (const q of asked) assert.ok(marked.has(q), `question ${q} is asked, but no privacy text waits for it: drop it once answered, with its marks`);
  // the four Web Store categories that wait are not ticked meanwhile
  const store = read('legal/chrome-web-store-privacy.md');
  for (const c of ['Authentication information', 'Location', 'Web history', 'User activity']) {
    assert.match(store, new RegExp(`^- ${c}: pending\\.[^\\n]*\\[Pending attorney answer`, 'm'), `chrome-web-store-privacy.md answers "${c}" before the attorney has`);
  }
});

test('the privacy texts stay templates for any dealership', () => {
  // the same words as test/anyDealer.test.js and test/marketing.test.js
  const PILOT = /Waynesburg|Ron Lewis|Cranberry|Pleasant Hills|15370|\$\s?490\b|\bRoger\b|ronlewis/i;
  for (const f of PRIVACY_TEXTS) {
    const hit = read(f).match(PILOT);
    assert.equal(hit, null, `${f} contains the pilot value "${hit && hit[0]}"`);
  }
});
