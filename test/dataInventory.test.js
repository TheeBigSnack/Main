// docs/data-inventory.md lists everything Lot Sync stores or sends, read
// from the code, and the privacy texts are checked against it. These tests
// keep the page true as the code grows: each fails when the code gains
// something the page does not name (a chrome.storage key or area, a table or
// a column, an Edge Function, an outside host, a field sent to the rewrite
// service), when the page names something the code no longer has, and when a
// recipient the page names is missing from a privacy text that must name it.
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

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const inventory = read('docs/data-inventory.md');
const policy = read('legal/privacy-policy.md');
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
const SHIPPED = [...walk('extension'), ...walk('manager'), ...walk('site'), ...walk('supabase/functions'), ...walk('backend')]
  .filter((f) => /\.(js|mjs|ts|html)$/.test(f) || f === 'extension/manifest.json')
  .filter((f) => !/package(-lock)?\.json$/.test(f));
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
    const hit = source(f).match(/<(script|link|img|iframe)\b[^>]*\b(src|href)="(https?:)?\/\/[^"]*"/i);
    assert.equal(hit, null, `${f} loads ${hit && hit[0]} from another host: the inventory says the website loads nothing from elsewhere`);
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

test('every view the migrations create is named in the database section', () => {
  const db = section(inventory, "## Lot Sync's database (Supabase)");
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
    vehicle: CAR, dealer: { name: 'Example Motors', city: 'Springfield', state: 'OH', zip: '43215' }, salesperson: { name: 'Pat', title: 'sales consultant' },
    priceNote: 'Tax and tags extra.', price: 25990, settings: { rewrite: { enabled: true, endpoint: 'https://rewrite.test', key: 'k' } }, origin: 'https://www.example-motors.test', fetchImpl,
  });
  assert.ok(body, 'generateDescription did not call the rewrite service');
  return body;
}

test('the rewrite service gets exactly the fields "Exactly what reaches Anthropic" lists, and never a VIN or a price field', async () => {
  const body = await sentToRewrite();
  assert.equal(body.origin, 'https://www.example-motors.test', 'the origin goes with the facts');
  assert.ok(read('supabase/functions/rewrite/index.ts').includes('delete facts.origin;'), 'the rewrite function no longer removes origin before the facts reach Anthropic: update the inventory');
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

test('a colour guess sends the photo addresses and the colour words, nothing else', async () => {
  let body = null;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ ok: true, exterior: 'Gray' }) };
  };
  await guessColorsWithBackend({ endpoint: 'https://rewrite.test', photos: CAR.photos, options: ['Gray', 'Black'], fetchImpl });
  assert.deepEqual(Object.keys(body).sort(), ['options', 'photos'], 'the colour guess sends more than the inventory says: update "Exactly what reaches Anthropic"');
  assert.match(section(inventory, '### Exactly what reaches Anthropic'), /up to four photo addresses[^.]*and the list of colour words\. Nothing else\./);
});

test('the sync row names every part of the sync payload', () => {
  const body = syncPayload({ origin: 'https://www.example-motors.test', posted: {}, pilot: null, scan: null, since: null, userId: 'u' });
  const t = tables(section(inventory, '## What leaves the browser'))[0];
  const row = t.rows.find((r) => r[0].startsWith('Sync '));
  assert.ok(row, 'the network table has no Sync row');
  const sent = row[column(t, 'What is sent')];
  for (const k of Object.keys(body)) assert.ok(sent.includes('`' + k + '`'), `the sync payload carries ${k}, and the Sync row does not name it`);
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
