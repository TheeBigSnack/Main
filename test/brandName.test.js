// The product's name is Lot Current (renamed from Lot Sync on 2026-10-01,
// because LotSync LLC already uses that name for dealership software). This
// test keeps the old name out of everything people can see: every text file in
// the repo, code comments included (the owner and the testers read those), in
// any spelling (with or without a space, hyphen, dot, underscore,
// a non-breaking or zero-width space, an HTML entity, a JS escape or a URL
// escape, Markdown emphasis or an inline HTML or SVG tag between the words,
// and across a wrapped line), and in file names, the names of images and
// other binary files included.
//
// Some internal names keep the old spelling on purpose: renaming them would
// break data on pilot installs, the database, CI or Stripe, and no customer
// sees them. Those are listed in KEPT below, each with its reason and only the
// files it is used in, so a name shaped like a kept one is still caught in
// the extension, the website, the manager view or a document people read.
// Every entry must still be in use where it is allowed, so the list cannot
// quietly grow into a loophole.
//
// The few places that must still say the old name are exempt line by line:
// HANDOFF.md (the session history), CHANGELOG.md's released sections and the
// one Unreleased bullet that announces the rename, and the trademark note and
// the attorney questions on lines that explain the conflict.
//
// The scan itself is the pure function scanFiles() below; the last tests feed
// it made-up files to prove it catches what it should and only that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const posix = (p) => p.split(sep).join('/');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const NEW_NAME = 'Lot Current';
// This file spells the kept names (it has to, to allow them) and the old name
// for its own proofs, so it is exempt from its own scan.
const SELF = posix(relative(root, fileURLToPath(import.meta.url)));

// ---------- what counts as the old name ----------

// Anything that can sit between "lot" and "sync" on one line: whitespace other
// than a line break (the non-breaking space included), soft hyphens,
// zero-width spaces and joiners, the Unicode hyphens and dashes, the minus
// sign, underscore, dot and hyphen, and Markdown's emphasis and code marks
// (* _ ~ and the backtick).
const SEP = '[\\t\\v\\f\\r \\u00a0\\u00ad\\u1680\\u2000-\\u200d\\u2010-\\u2015\\u2028\\u2029\\u202f\\u205f\\u2060\\u2212\\u3000\\ufeff_.*`~\\-]*';
// A line break, optionally followed by the comment or quote marker that
// starts a wrapped comment or quote line (// # * -- > ; <!--).
const WRAP = `(?:\\n${SEP}(?:(?://|/?\\*|#|--|>|;|<!--)${SEP})?)?`;
// "lot" where a word starts: not straight after a letter ("pilot sync",
// "ballotSync" and "slotsync" are other words; after a digit it starts one,
// as in "2026lotsync.csv"), except a capital L after a small letter, which
// starts the next word of a camelCase name ("initLotSync"), and "Lot" after a
// capital, the next word after an acronym ("UILotSync"). In all capitals no
// word start shows ("PILOTSYNC" is the pilot's sync), so an L inside a run of
// capitals starts no word. The case is spelled out in the classes, so the
// expressions carry no i flag, which would make that capital L match any l.
const LOT = '(?:(?<![A-Za-z])[Ll][Oo][Tt]|(?<=[a-z])L[Oo][Tt]|(?<=[A-Z])Lot)';
const SYNC = '[Ss][Yy][Nn][Cc]';
const OLD_NAME = new RegExp(`${LOT}${SEP}${WRAP}${SYNC}`, 'g');
const OLD_NAME_ONE = new RegExp(`${LOT}${SEP}${SYNC}`);

// HTML entities, JS escapes and URL escapes are decoded first, so
// "Lot&nbsp;Sync", "Lot\u00a0Sync" written as an escape, "Lot%20Sync" in an
// address and "subject=Lot+Sync" in a mail link are caught too. A plus is read
// as a space only in a key=value pair after a ? or & (an address's query, a
// mail link's subject), so "lot+sync" and "x &=lot+sync" in code are left
// alone, but so is a form body with no ? or & in front ("q=Lot+Sync"), and
// the rare code shaped like a pair ("a?b=lot+sync") is read as one. An
// escaped plus ("%2B") stays a plus. A run of escapes that is not UTF-8 is
// read as Latin-1, as JavaScript's escape() writes it ("Lot%A0Sync").
// Inline tags that can sit inside a name ("Lot<wbr>Sync",
// "Lot <strong>Sync</strong>", an SVG "<tspan>") are removed when tags is
// true. A tag is removed with its attributes, so the scan reads every line
// both ways: with those tags removed, and with them kept, where an old name
// inside an attribute (title="...", href="...", download="...") is still
// caught.
const INLINE_TAG = /<\/?(?:wbr|br|b|i|em|strong|span|u|s|mark|small|abbr|sup|sub|a|code|kbd|tspan|font|del|ins|q|cite|var|dfn|bdi|bdo|time|data|label)\b[^>]*>/gi;
const NAMED = {
  nbsp: '\u00a0', shy: '\u00ad', ZeroWidthSpace: '\u200b', zwnj: '\u200c', zwj: '\u200d', NoBreak: '\u2060',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', hairsp: '\u200a', hyphen: '\u2010', dash: '\u2010',
  ndash: '\u2013', mdash: '\u2014', minus: '\u2212', period: '.', lowbar: '_', UnderBar: '_', amp: '&', AMP: '&',
};
const char = (n) => (n === 10 || n === 13 ? ' ' : n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');
const latin1 = (run) => run.replace(/%([0-9a-f]{2})/gi, (_, h) => char(parseInt(h, 16)));
const urlRun = (run) => { try { return decodeURIComponent(run).replace(/[\r\n]/g, ' '); } catch { return latin1(run); } };
function decode(line, { tags = true } = {}) {
  return (tags ? line.replace(INLINE_TAG, '') : line)
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_, h) => char(parseInt(h, 16)))
    .replace(/&#(\d{1,7});?/g, (_, d) => char(Number(d)))
    .replace(/&([A-Za-z]+);/g, (m, name) => NAMED[name] ?? m)
    .replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi, (_, a, b, c) => char(parseInt(a || b || c, 16)))
    .replace(/[?&][\w.~-]+=[^\s"'<>&#]*/g, (pair) => pair.replace(/\+/g, ' '))
    .replace(/(?:%[0-9a-f]{2})+/gi, urlRun);
}

// ---------- the internal names kept on purpose ----------
// files: a list of exact paths (the entry applies only there, and must be in
// use in every one of them), or a pattern on the path (the entry applies to
// those files and must be in use in at least one), or absent (any file, in use
// somewhere). Each is removed from a line before the line is checked.

const CODE = /\.(js|mjs|ts|html)$/;
const KEPT = [
  { re: /'lot-sync-rescan'/, files: ['extension/src/rescanSchedule.js', 'test/e2e/wizard.e2e.mjs'],
    why: "the rescan alarm's name: installs that already set the alarm would get a second one" },
  { re: /`lot-sync-\$\{origin\}`/, files: ['extension/background.js'],
    why: 'the notification id, never shown; one notification per website replaces the last' },
  { re: /\bpostedWith\W{1,6}'lotsync'/, files: ['extension/sidepanel.js', 'test/accountFlow.test.js'],
    why: "a value kept with every post in each install's local posted list (sync.js never sends it to the database)" },
  { re: /\blotsync_[a-z0-9_]+/, files: /^(supabase\/(README\.md|tests\/[^/]+\.sql)|test\/[^/]+\.test\.js)$/,
    why: 'SQL names (dblink connections, the local test database lotsync_test)' },
  { re: /\blotsync\.concurrency_failure\b/, files: ['supabase/tests/concurrency.sql', 'test/sqlTest.test.js'],
    why: 'the SQL setting the concurrency test reports through' },
  { re: /'lotsync\\{1,2}_%'/, files: ['supabase/tests/concurrency.sql', 'test/sqlTest.test.js'],
    why: "the SQL pattern matching the concurrency test's own connection names" },
  { re: /\bLOTSYNC_[A-Z0-9_]+/, files: /^(\.github\/workflows\/[^/]+\.ya?ml|docs\/[^/]+\.md|supabase\/README\.md|(demo|scripts)\/[^/]+\.mjs|test\/.+\.(js|mjs))$/,
    why: 'environment variables set on machines, in CI and in the docs that tell the owner how to set them' },
  { re: /\bLOT_SYNC_[A-Z0-9_]+/, files: /^(demo|test)\/.+\.(js|mjs|html)$/,
    why: "the sample websites' window globals, read by the sandbox and the tests" },
  { re: /\b_*lotSync[A-Za-z0-9]*/, files: /^((demo|scripts|test)\/.+\.(js|mjs|html)|extension\/src\/readyList\.js)$/,
    why: "JS identifiers and element ids in the sandbox, the scripts and the tests, the sandbox's sessionStorage keys, the survey report's JSON keys, and the readyList source value (worked out when the list is drawn, never stored)" },
  { re: /\bLotSyncShim\b/, files: /^(demo|test)\/.+\.(js|mjs)$/,
    why: "the sandbox's chrome shim global" },
  { re: /\blotsync-customer-/, files: ['supabase/functions/billing/index.ts', 'test/fn-billing.test.js'],
    why: 'the Stripe idempotency key prefix: a new prefix could make a second Stripe customer for a retried click' },
  { re: /\bproject_id = "lot-sync"/, files: ['supabase/config.toml'],
    why: "the Supabase CLI's local project id: renaming it renames the local database container and its data" },
  { re: /\bsupabase_db_\$\{[^}]*\|\| 'lot-sync'\}/, files: ['scripts/stack-test.mjs'],
    why: 'the local database container name that follows from that project id' },
  { re: /\blotsync-stack\.test\b/, files: /^(\.github\/workflows\/[^/]+\.ya?ml|docs\/stack-test\.md|scripts\/stack-test\.mjs|test\/stack\/[^/]+\.mjs)$/,
    why: 'the made-up host names the CI stack test runs under' },
  { re: /\bE:\\LotSync\b/, files: ['docs/survey.md'],
    why: "the owner's real Windows folder" },
  { re: /\bD:\\lotsync-tmp\b/, files: ['README.md', 'docs/survey.md'],
    why: "the owner's real Windows temp folder" },
];

const appliesTo = (entry, path) =>
  Array.isArray(entry.files) ? entry.files.includes(path) : entry.files ? entry.files.test(path) : true;
const everywhere = (re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');

// ---------- the lines that may still say the old name ----------

const RENAME_BULLET = '**Renamed to Lot Current**';
const LEGAL_CONFLICT = /LotSync LLC|until 2026-10-01|\bformer name\b|\bformerly\b/i;
const LEGAL_FILES = ['legal/trademark-note.md', 'legal/questions-for-attorney.md'];

// One boolean per line: true where the line is exempt. Problems with the
// exemptions themselves (two rename bullets, an announcement that is not a
// bullet) go to problems.
function exemptLines(path, lines, problems, self) {
  if (path === 'HANDOFF.md' || path === self) return lines.map(() => true);
  if (path === 'CHANGELOG.md') {
    // Released history: from the first "## " heading that is not Unreleased on.
    const released = lines.findIndex((l) => /^## /.test(l) && !/^## Unreleased\b/.test(l));
    const end = released === -1 ? lines.length : released;
    const out = lines.map((_, i) => i >= end);
    const at = [];
    for (let i = 0; i < end; i++) if (lines[i].includes(RENAME_BULLET)) at.push(i);
    if (at.length > 1) problems.push(`CHANGELOG.md: the rename is announced on lines ${at.map((i) => i + 1).join(' and ')}; keep it to one bullet`);
    else if (at.length === 1) {
      const i = at[0];
      if (!/^\s*[-*+] /.test(lines[i])) problems.push(`CHANGELOG.md:${i + 1}: the rename announcement must be a bullet ("- ${RENAME_BULLET} ...")`);
      else {
        out[i] = true; // the bullet, and its indented continuation lines
        for (let j = i + 1; j < end && /^\s+\S/.test(lines[j]); j++) out[j] = true;
      }
    }
    return out;
  }
  if (LEGAL_FILES.includes(path)) return lines.map((l) => LEGAL_CONFLICT.test(l));
  return lines.map(() => false);
}

// ---------- the scan ----------

// paths: repo-relative paths. Returns "path: the file name carries the old
// name" for each one whose name does. It covers the files that are not read
// (images, PDFs, zips) as well as the ones scanFiles reads.
const nameHits = (paths) => paths.filter((p) => OLD_NAME_ONE.test(decode(p))).map((p) => `${p}: the file name carries the old name`);

// files: [{ path, text }] with repo-relative, forward-slash paths.
// Returns { hits, problems }: hits are "path:line: text" for every line still
// carrying the old name; problems are broken exemptions.
function scanFiles(files, { kept = KEPT, self = SELF } = {}) {
  const hits = [];
  const problems = [];
  const removers = kept.map((k) => ({ ...k, all: everywhere(k.re) }));
  for (const { path, text } of files) {
    hits.push(...nameHits([path]));
    const lines = text.split(/\r?\n/);
    const exempt = exemptLines(path, lines, problems, self);
    const seen = new Set();
    // Each line is read twice: with inline tags removed, then with them kept.
    for (const tags of [true, false]) {
      const clean = lines.map((line, i) => {
        if (exempt[i]) return '<exempt>';
        let s = decode(line, { tags });
        for (const k of removers) if (appliesTo(k, path)) s = s.replace(k.all, '<kept>');
        return s;
      });
      const starts = [];
      let at = 0;
      for (const s of clean) { starts.push(at); at += s.length + 1; }
      for (const m of clean.join('\n').matchAll(OLD_NAME)) {
        let i = starts.length - 1;
        while (starts[i] > m.index) i--;
        seen.add(i);
      }
    }
    for (const i of [...seen].sort((a, b) => a - b)) hits.push(`${path}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
  }
  return { hits, problems };
}

// Every KEPT entry must still be in use where it is allowed: an entry with a
// list of files in each of them, any other entry in at least one file it
// applies to. Exempt files (HANDOFF.md, this file) do not count.
function staleKept(files, { kept = KEPT, self = SELF } = {}) {
  const problems = [];
  const texts = new Map(files.filter((f) => f.path !== 'HANDOFF.md' && f.path !== self).map((f) => [f.path, decode(f.text, { tags: false })]));
  for (const k of kept) {
    if (Array.isArray(k.files)) {
      for (const p of k.files) {
        if (!texts.has(p)) problems.push(`KEPT allows ${k.re} in ${p}, but there is no such file: take it off the list`);
        else if (!k.re.test(texts.get(p))) problems.push(`KEPT allows ${k.re} in ${p}, but ${p} no longer uses it: take ${p} off the list (and the entry, if it was the last)`);
      }
    } else if (![...texts].some(([p, t]) => appliesTo(k, p) && k.re.test(t))) {
      problems.push(`KEPT allows ${k.re}, but no file uses it any more: remove the entry`);
    }
  }
  return problems;
}

// ---------- the repo's text files ----------

// git lists the files whenever it can run: everything it tracks, plus new
// files it does not ignore, with every ignore rule git itself applies (the
// .gitignore files, the checkout's .git/info/exclude and the person's own
// global ignore file, where an editor or another tool may hide a folder named
// after the checkout). So the scan reads what git would show and nothing a
// person's machine keeps out of git, and an ignored local file (backend/.env)
// is never read. Only without git (a copy of the repo on a machine with no git)
// does the walk below stand in: it honours the .gitignore files (the simple
// patterns they use: names, paths, * and a trailing /) and .git/info/exclude,
// but cannot find the global ignore file. Binary files are listed too, for the
// file-name check; only text files are read.
const SKIP = new Set(['.git', 'node_modules', 'dist', 'survey-out', 'test/e2e/screenshots']);
const BINARY = /\.(png|ico|zip|jpe?g|gif|webp|woff2?|ttf|otf|pdf|mp4|webm)$/i;

function ignoreRules(base, text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!')).map((p) => {
    const dirOnly = p.endsWith('/');
    const body = p.replace(/\/$/, '').replace(/^\//, '');
    const glob = body.split('*').map(escapeRe).join('[^/]*');
    return { base, dirOnly, re: new RegExp(p.replace(/\/$/, '').includes('/') ? `^${glob}$` : `(^|/)${glob}$`) };
  });
}
const ignored = (rules, rel, isDir) =>
  rules.some((r) => (!r.dirOnly || isDir) && rel.startsWith(r.base) && r.re.test(rel.slice(r.base.length)));

// base: the folder to list; git and env: the git command and its environment
// (the proof test points them elsewhere).
function repoFiles(base = root, { git = 'git', env = process.env } = {}) {
  const found = new Set();
  const listed = spawnSync(git, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: base, env, encoding: 'utf8' });
  if (listed.status === 0) {
    for (const p of listed.stdout.split('\0')) {
      if (p && existsSync(join(base, p)) && lstatSync(join(base, p)).isFile()) found.add(p);
    }
    return [...found].sort();
  }
  const walk = (dir, rules) => {
    const prefix = dir ? `${dir}/` : '';
    const gi = join(base, dir, '.gitignore');
    const here = existsSync(gi) ? [...rules, ...ignoreRules(prefix, readFileSync(gi, 'utf8'))] : rules;
    for (const name of readdirSync(join(base, dir))) {
      const rel = prefix + name;
      if (SKIP.has(name) || SKIP.has(rel)) continue;
      const st = lstatSync(join(base, rel));
      if (st.isSymbolicLink()) continue;
      if (ignored(here, rel, st.isDirectory())) continue;
      if (st.isDirectory()) walk(rel, here);
      else found.add(rel);
    }
  };
  const exclude = join(base, '.git', 'info', 'exclude');
  walk('', existsSync(exclude) ? ignoreRules('', readFileSync(exclude, 'utf8')) : []);
  return [...found].sort();
}

// A file another process removes between the listing and the read is skipped.
const readIfThere = (path) => { try { return read(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const PATHS = repoFiles();
const FILES = PATHS.filter((p) => !BINARY.test(p)).map((path) => ({ path, text: readIfThere(path) })).filter((f) => f.text !== null);
const list = (lines) => lines.map((l) => `  ${l}`).join('\n');

// ---------- the real repo ----------

test('the file list covers the repo and skips what git ignores', () => {
  const paths = FILES.map((f) => f.path);
  assert.ok(paths.length > 300, `only ${paths.length} files found`);
  for (const p of ['extension/manifest.json', 'package.json', 'README.md', 'CHANGELOG.md', '.github/workflows/ci.yml', 'supabase/config.toml', SELF]) {
    assert.ok(paths.includes(p), `${p} was not walked`);
  }
  for (const dir of ['site/', 'site-src/pages/', 'demo/site/photos/', 'legal/', 'marketing/']) {
    assert.ok(paths.some((p) => p.startsWith(dir)), `nothing under ${dir} was walked`);
  }
  for (const p of paths) {
    assert.doesNotMatch(p, /^(\.git|node_modules|dist|survey-out|test\/e2e\/screenshots|demo\/screenshots)\//, `${p} should not be scanned`);
    assert.notEqual(p, 'backend/.env', 'the local secrets file must never be read');
    assert.doesNotMatch(p, BINARY, `${p} is binary`);
  }
  // binary files are listed (for the file-name check), though not read
  assert.ok(PATHS.includes('extension/icons/icon128.png'), 'the icons were not listed');
});

test(`nothing people can see still says the old name (it is ${NEW_NAME} now)`, () => {
  const scan = scanFiles(FILES);
  const { problems } = scan;
  const hits = [...nameHits(PATHS.filter((p) => BINARY.test(p))), ...scan.hits];
  assert.equal(problems.length, 0, `The exemptions are broken:\n${list(problems)}`);
  assert.equal(hits.length, 0,
    `The old name is still in ${hits.length} place(s), as file:line:\n${list(hits)}\n` +
    `Change each to ${NEW_NAME}. If one is an internal name that must keep the old spelling, add a narrow entry to KEPT in ${SELF} with its reason.`);
});

test('every kept internal name is still in use where it is allowed', () => {
  for (const k of KEPT) assert.ok(k.why && k.why.length > 10, `${k.re} needs its one-line reason`);
  const problems = staleKept(FILES);
  assert.equal(problems.length, 0, `KEPT has gone stale:\n${list(problems)}`);
});

test('the extension, the packages and the zip carry the new name', () => {
  assert.equal(JSON.parse(read('extension/manifest.json')).name, NEW_NAME);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'lot-current');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.name, 'lot-current');
  assert.equal(lock.packages[''].name, 'lot-current');
  assert.equal(JSON.parse(read('backend/package.json')).name, 'lot-current-backend');
  const backendLock = JSON.parse(read('backend/package-lock.json'));
  assert.equal(backendLock.name, 'lot-current-backend');
  assert.equal(backendLock.packages[''].name, 'lot-current-backend');
  assert.match(read('scripts/pack.mjs'), /'dist',\s*`lot-current-extension-\$\{manifest\.version\}\.zip`/, 'npm run pack must write dist/lot-current-extension-<version>.zip');
});

test("the website's name and the share images' line say the new name", async () => {
  const { SITE_NAME } = await import('../scripts/site-pages.mjs');
  assert.equal(SITE_NAME, NEW_NAME);
  const { LINE } = await import('../scripts/social-images.mjs');
  assert.match(LINE, new RegExp(`\\b${NEW_NAME}\\b`));
  assert.equal(LINE, `You click Publish. ${NEW_NAME} never does.`);
});

// ---------- proofs on made-up files ----------

test('the old name added to a real file is caught with the real KEPT list', () => {
  for (const [path, added] of [
    ['extension/popup.js', "status.textContent = 'Lot Sync scanned the website';"],
    ['marketing/sales-sheet.md', 'Try LotSync today.'],
    ['extension/manifest.json', '"short_name": "Lot Sync",'],
    ['test/e2e/wizard.e2e.mjs', "const csv = 'lot-sync-pilot-2026-10-01.csv';"],
    // shaped like a kept internal name, but in a file people see or a download they get
    ['extension/popup.js', 'a.download = `lotSync-pilot-${day}.csv`;'],
    ['extension/popup.js', 'a.download = `lotsync_pilot_${day}.csv`;'],
    ['manager/manager.js', 'a.download = `lotsync_manager_${day}.csv`;'],
    ['extension/popup.html', '<h1 class="brand">lotSync</h1>'],
    ['site/index.html', '<span class="wordmark">lotSync</span>'],
    ['extension/sidepanel.html', '<title>LOT_SYNC_PANEL</title>'],
    ['extension/sidepanel.js', 'window.LotSyncShim = shim;'],
    ['marketing/sales-sheet.md', 'Questions? Write to LOTSYNC_SUPPORT.'],
    ['README.md', 'Set LOTSYNC_CHROME to your Chrome.'],
    ['legal/terms-of-service.md', 'Lot Current runs at app.lotsync-stack.test.'],
  ]) {
    const real = FILES.find((f) => f.path === path);
    assert.ok(real, `${path} is in the repo`);
    const text = `${real.text.replace(/\n$/, '')}\n${added}\n`;
    const { hits } = scanFiles(FILES.map((f) => (f === real ? { path, text } : f)));
    const line = text.split('\n').length - 1;
    assert.ok(hits.includes(`${path}:${line}: ${added}`), `${path}: ${hits.join('\n')}`);
  }
});

const scanOne = (path, text) => scanFiles([{ path, text }]);
const hitsIn = (path, text) => scanOne(path, text).hits;

test('the scan catches the old name in every spelling, in any file that is not exempt', () => {
  const spellings = [
    'Install Lot Sync from the Web Store.',
    'LotSync reads the website.',
    "a.download = 'lot-sync-pilot-x.csv';",
    'Lot\u00a0Sync',
    'what lot sync does',
    'LOT SYNC',
    'LOT_SYNC',
    'lot.sync',
    'Lot\u2011Sync',
    'Lot\u200bSync',
    'Lot&nbsp;Sync',
    'Lot&#160;Sync',
    'Lot&#xA0;Sync',
    'Lot<wbr>Sync',
    'Lot <strong>Sync</strong>',
    'Lot<br>Sync',
    'Try Lot **Sync** today.',
    'Try **Lot** Sync today.',
    'Lot ~~Sync~~',
    'Lot `Sync`',
    '<text>Lot <tspan>Sync</tspan></text>',
    'Lot <a href="/">Sync</a>',
    // inside the attributes of an inline tag
    '<a href="https://lotsync.example/terms">terms</a>',
    '<a download="lot-sync-pilot-2026-10-01.csv">Download CSV</a>',
    '<span title="Lot Sync">Home</span>',
    '<label class="lot-sync">Website</label>',
    String.raw`title: 'Lot\u00a0Sync'`,
    String.raw`title: 'Lot\x20Sync'`,
    // where a word starts, after a mark or as the next word of a camelCase name
    'initLotSync();',
    'see (LotSync) and x.lotsync',
    'MY_LOTSYNC_KEY',
    'lOt SyNc',
    // glued to what comes before: the next word after a capitalised acronym, or after a digit
    'the UILotSync panel',
    'Download 2026lotsync.csv',
    'v2lot-sync',
    // the spellings a careless edit is most likely to bring back
    'Lot-Sync',
    'lot_sync',
    'LOTSYNC',
    'Lot  Sync',
    // URL escapes: in an address, a download name or a mail link's subject
    '<a href="https://www.example.com/?q=Lot%20Sync">search</a>',
    '<a download="Lot%2DSync%2Dpilot.csv">Download CSV</a>',
    '<a href="mailto:x@lotcurrent.com?subject=Lot+Sync+demo">Email us</a>',
    '<a href="mailto:x@lotcurrent.com?to=x&amp;subject=Lot+Sync">Email us</a>',
    'https://www.example.com/Lot%C2%A0Sync',
    'L%6F%74%53ync',
    // an escape run that is not UTF-8 is read as Latin-1 (JavaScript's escape() writes those)
    '<a href="/s/Lot%A0Sync">search</a>',
    // and "&AMP;", HTML's capitalised "&amp;", in front of a query pair
    '<a href="/s?a=1&AMP;subject=Lot+Sync">Email us</a>',
  ];
  for (const text of spellings) {
    for (const path of ['docs/help.md', 'extension/popup.js', 'site/index.html', 'marketing/sales-sheet.md']) {
      assert.deepEqual(hitsIn(path, `first line\n${text}\nlast line`), [`${path}:2: ${text.trim()}`], `${JSON.stringify(text)} in ${path}`);
    }
  }
  // across a wrapped line, plain or in a comment, reported where it starts
  assert.deepEqual(hitsIn('docs/help.md', 'Open Lot\nSync from the toolbar.'), ['docs/help.md:1: Open Lot']);
  assert.deepEqual(hitsIn('extension/popup.js', '// the Lot\n// Sync popup'), ['extension/popup.js:1: // the Lot']);
  assert.deepEqual(hitsIn('legal/terms.md', '> Lot\n> Sync never clicks Publish'), ['legal/terms.md:1: > Lot']);
  // a file name
  assert.deepEqual(hitsIn('docs/lot-sync-guide.md', 'clean'), ['docs/lot-sync-guide.md: the file name carries the old name']);
  // and nothing else
  // nor a longer word that ends in "lot" ("pilot", "ballot", "slot", "allot")
  // nor a plus that is not in a key=value pair after a ? or & (code's "&=" and "??=" included), an
  // escaped plus (a plus, not a space), an escaped mark that is no separator, or a broken UTF-8
  // escape (read as Latin-1, its letters are no separator either)
  for (const text of ['Lot Current', 'the lot is in sync with the website', 'a parking lot; sync later', 'lots synced', 'the **lot** is in `sync`', '<b>lot</b> and <i>sync</i>', 'the pilot sync runs nightly', 'ballotSync()', 'a slot-sync job', 'PILOTSYNC', 'allot_sync', 'PilotSync',
    'const n = lot+sync;', '?tags=lot+%26+sync', 'x &=lot+sync;', 'a ??=lot+sync', '?q=lot%2Bsync', 'a lot%E2%80sync']) {
    assert.deepEqual(hitsIn('docs/help.md', text), [], text);
  }
});

test('a kept internal name passes only where KEPT allows it, and never hides the old name next to it', () => {
  const alarm = "export const RESCAN_ALARM = 'lot-sync-rescan';";
  assert.deepEqual(hitsIn('extension/src/rescanSchedule.js', alarm), []);
  assert.deepEqual(hitsIn('extension/popup.js', alarm), [`extension/popup.js:1: ${alarm}`], 'the alarm name belongs to its own files');
  assert.deepEqual(hitsIn('extension/background.js', 'chrome.notifications.create(`lot-sync-${origin}`, {});'), []);
  assert.deepEqual(hitsIn('extension/sidepanel.js', "const extra = { postedWith: 'lotsync' };"), []);
  assert.deepEqual(hitsIn('extension/popup.js', "const extra = { postedWith: 'lotsync' };").length, 1);
  assert.deepEqual(hitsIn('supabase/config.toml', 'project_id = "lot-sync"'), []);
  assert.deepEqual(hitsIn('supabase/config.toml', 'name = "lot-sync"').length, 1);
  assert.deepEqual(hitsIn('scripts/stack-test.mjs', "const dbContainer = `supabase_db_${projectId() || 'lot-sync'}`;"), []);
  assert.deepEqual(hitsIn('supabase/functions/billing/index.ts', '`lotsync-customer-${id}-first`'), []);
  assert.deepEqual(hitsIn('docs/help.md', 'lotsync-customer-').length, 1);
  assert.deepEqual(hitsIn('docs/survey.md', 'cd E:\\LotSync'), []);
  assert.deepEqual(hitsIn('docs/help.md', 'cd E:\\LotSync').length, 1, "the owner's folder belongs to the files that name it");
  assert.deepEqual(hitsIn('supabase/tests/concurrency.sql', "if c like 'lotsync\\_%' then"), []);
  for (const [path, text] of [
    ['scripts/survey.mjs', 'const chrome = process.env.LOTSYNC_CHROME;'],
    ['docs/website.md', '`LOTSYNC_SITE_ORIGIN=<siteUrl> npm run check-deploy`'],
    ['demo/demo.js', 'window.__lotSyncHub = hub; const Shim = window.LotSyncShim; const inv = window.LOT_SYNC_INVENTORY;'],
    ['demo/index.html', '<button type="button" id="lotSyncButton" title="Lot Current">'],
    ['supabase/README.md', 'createdb lotsync_test'],
    ['.github/workflows/ci.yml', 'LEAD_ORIGINS: https://site.lotsync-stack.test'],
  ]) assert.deepEqual(hitsIn(path, text), [], `${path}: ${text}`);
  // code identifiers are allowed only where they are used: the sandbox, the scripts and the tests
  assert.deepEqual(hitsIn('docs/help.md', 'Click lotSyncButton.').length, 1);
  assert.deepEqual(hitsIn('extension/popup.html', '<button id="lotSyncButton">').length, 1);
  assert.deepEqual(hitsIn('manager/manager.js', 'const inv = window.LOT_SYNC_INVENTORY;').length, 1);
  assert.deepEqual(hitsIn('site/index.html', '<p>LOTSYNC_SITE_ORIGIN</p>').length, 1);
  assert.deepEqual(hitsIn('backend/server.js', "pool.query('select 1 from lotsync_leads');").length, 1);
  // removing a kept name never hides the old name beside it
  assert.deepEqual(hitsIn('docs/website.md', 'Set LOTSYNC_CHROME so Lot Sync finds Chrome.').length, 1);
  assert.deepEqual(hitsIn('extension/src/rescanSchedule.js', "'lot-sync-rescan' // the Lot Sync alarm").length, 1);
});

test('the exemptions are exactly as narrow as documented', () => {
  assert.deepEqual(hitsIn('HANDOFF.md', 'Lot Sync\nLotSync'), []);
  assert.deepEqual(hitsIn('docs/HANDOFF.md', 'Lot Sync').length, 1, 'only the root HANDOFF.md');

  const changelog = [
    '# Changelog',
    '',
    '## Unreleased',
    '',
    'Changed',
    `- ${RENAME_BULLET} (2026-10-01): it was called Lot Sync.`,
    '  LotSync LLC already uses that name.',
    '- Lot Sync reads more websites.',
    '',
    '## 0.5.0 (2026-09-28)',
    '- Lot Sync never clicks Publish.',
    '## 0.4.0',
    'LotSync',
  ].join('\n');
  assert.deepEqual(hitsIn('CHANGELOG.md', changelog), ['CHANGELOG.md:8: - Lot Sync reads more websites.']);
  assert.equal(hitsIn('backend/CHANGELOG.md', changelog).length, 5, 'only the root CHANGELOG.md');
  const top = hitsIn('CHANGELOG.md', '# Changelog for Lot Sync\n\n## Unreleased\n');
  assert.deepEqual(top, ['CHANGELOG.md:1: # Changelog for Lot Sync'], 'above Unreleased is not history');
  const twice = scanOne('CHANGELOG.md', `## Unreleased\n- ${RENAME_BULLET}: was Lot Sync.\n- ${RENAME_BULLET} again: Lot Sync.\n`);
  assert.equal(twice.hits.length, 2);
  assert.match(twice.problems.join('\n'), /announced on lines 2 and 3; keep it to one bullet/);
  const notBullet = scanOne('CHANGELOG.md', `## Unreleased\n${RENAME_BULLET}: was Lot Sync.\n`);
  assert.equal(notBullet.hits.length, 1);
  assert.match(notBullet.problems.join('\n'), /must be a bullet/);

  for (const path of LEGAL_FILES) {
    assert.deepEqual(hitsIn(path, 'LotSync LLC (lot-sync.com) sells dealership software.'), []);
    assert.deepEqual(hitsIn(path, 'The product was called Lot Sync until 2026-10-01.'), []);
    assert.deepEqual(hitsIn(path, 'Its former name, Lot Sync, is taken.'), []);
    assert.deepEqual(hitsIn(path, 'Formerly Lot Sync.'), []);
    assert.deepEqual(hitsIn(path, 'Search "Lot Current" / "LotSync" at the USPTO.').length, 1);
  }
  assert.deepEqual(hitsIn('legal/terms.md', 'LotSync LLC is another company.').length, 1, 'only the two legal files that explain the conflict');

  // README.md is what testers and pilot salespeople read: no line there is exempt
  assert.deepEqual(hitsIn('README.md', 'Lot Current was called Lot Sync until 2026-10-01; reinstall it.').length, 1, 'README.md has no exemption');
  assert.deepEqual(hitsIn('README.md', 'Install Lot Sync.').length, 1);
});

test('a KEPT entry that is no longer used, or names a missing file, is reported', () => {
  const kept = [
    { re: /'lot-sync-rescan'/, files: ['extension/src/rescanSchedule.js', 'test/e2e/wizard.e2e.mjs'], why: 'test' },
    { re: /\bLOTSYNC_[A-Z0-9_]+/, why: 'test' },
    { re: /\bLOT_SYNC_[A-Z0-9_]+/, files: CODE, why: 'test' },
  ];
  const files = [
    { path: 'extension/src/rescanSchedule.js', text: "export const RESCAN_ALARM = 'lot-sync-rescan';" },
    { path: 'scripts/survey.mjs', text: 'process.env.LOTSYNC_CHROME' },
    { path: 'docs/help.md', text: 'window.LOT_SYNC_INVENTORY' },
    { path: SELF, text: "'lot-sync-rescan' window.LOT_SYNC_INVENTORY" },
  ];
  const problems = staleKept(files, { kept });
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.match(problems[0], /test\/e2e\/wizard\.e2e\.mjs, but there is no such file/);
  assert.match(problems[1], /LOT_SYNC_.*no file uses it any more/, 'a use outside its files, or in this file, does not count');
  const unused = staleKept([{ path: 'extension/src/rescanSchedule.js', text: "export const RESCAN_ALARM = 'rescan';" }, { path: 'test/e2e/wizard.e2e.mjs', text: "'lot-sync-rescan'" }], { kept: kept.slice(0, 1) });
  assert.deepEqual(unused, [`KEPT allows ${kept[0].re} in extension/src/rescanSchedule.js, but extension/src/rescanSchedule.js no longer uses it: take extension/src/rescanSchedule.js off the list (and the entry, if it was the last)`]);
});

test('the file list is what git shows: a file git ignores in any way is skipped, a new file is not, and binary files are listed for the name check', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lotcurrent-names-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A made-up checkout, with no GIT_* variables from the caller (a git hook sets
  // GIT_DIR, which would point these commands at the real repo).
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (...args) => spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  if (git('init', '-q').status !== 0) { t.skip('git is not installed'); return; }
  const put = (rel, text = 'x\n') => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  put('.gitignore', 'dist/\n');
  put('.git/info/exclude', '.idea/\n');
  put('.git/my-global-ignore', '**/.claude/settings.local.json\n');
  assert.equal(git('config', 'core.excludesFile', join(dir, '.git', 'my-global-ignore')).status, 0);
  put('README.md', `${NEW_NAME}\n`);
  put('docs/new-page.md');
  put('dist/lot-current-extension-0.5.0.md');
  put('.idea/LotSync.iml');
  put('.claude/settings.local.json', '{ "allow": ["Bash(git -C E:\\\\LotSync status)"] }\n');
  put('store/images/lot-sync-promo-1400x560.png');
  const listed = repoFiles(dir, { env });
  assert.deepEqual(listed, ['.gitignore', 'README.md', 'docs/new-page.md', 'store/images/lot-sync-promo-1400x560.png']);
  assert.deepEqual(nameHits(listed.filter((p) => BINARY.test(p))), ['store/images/lot-sync-promo-1400x560.png: the file name carries the old name']);
  // Without git, the walk honours .gitignore and .git/info/exclude; the
  // person's global ignore file is the one thing it cannot find.
  assert.deepEqual(repoFiles(dir, { git: join(dir, 'no-git-here'), env }),
    ['.claude/settings.local.json', '.gitignore', 'README.md', 'docs/new-page.md', 'store/images/lot-sync-promo-1400x560.png']);
});
