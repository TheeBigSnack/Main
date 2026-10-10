// The pilot zip (npm run pack -- --pilot): the normal zip's files, byte for
// byte, except src/accountConfig.js, whose url, anonKey and functionsUrl are
// empty so accountsConfigured() is false: no Account step in set-up, no
// sign-in under Settings, no sync with an account. The committed file is
// never written; the pack builds that one entry in memory, loads it as a
// module and refuses when it does not give accounts off or when the
// committed file no longer has the shape the rewrite expects.
// Without --pilot the pack is what it was: same name, same bytes.
//
// The packs run on a copy of the repository's extension/, scripts/ and
// package.json in a temporary folder, so dist/ here is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zip } from '../scripts/pack.mjs';
import { readZip } from '../scripts/store-check.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const VERSION = JSON.parse(read('extension/manifest.json')).version;
const COMMITTED = read('extension/src/accountConfig.js');
const NORMAL = `dist/lot-current-extension-${VERSION}.zip`;
const PILOT = `dist/lot-current-extension-${VERSION}-pilot.zip`;

// A module from its text, without a file: what the packed copy gives a browser.
const load = (text) => import(`data:text/javascript;base64,${Buffer.from(text, 'utf8').toString('base64')}`);

// A copy of what pack.mjs reads, in a fresh folder outside the repository.
function copy() {
  const dir = mkdtempSync(join(tmpdir(), 'lot-current-pack-'));
  for (const p of ['extension', 'scripts', 'package.json']) cpSync(join(ROOT, p), join(dir, p), { recursive: true });
  return dir;
}

function pack(dir, ...args) {
  return packWithEnv(dir, {}, ...args);
}

// npm's own settings reach the script as npm_config_* variables: a pack here
// carries npm_config_pilot only when the test sets it.
function packWithEnv(dir, env, ...args) {
  const base = { ...process.env };
  delete base.npm_config_pilot;
  const r = spawnSync(process.execPath, [join(dir, 'scripts/pack.mjs'), ...args], { cwd: dir, encoding: 'utf8', env: { ...base, ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// extension/'s files as pack.mjs walks them: sorted, editor leftovers skipped.
function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = relative(base, full).split(sep).join('/');
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else if (!/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|.*\.swp|.*~)$/.test(rel)) out.push(rel);
  }
  return out;
}

test('without --pilot the pack is unchanged: the same name and the same bytes as a zip of extension/, and no pilot zip', () => {
  const dir = copy();
  try {
    const r = pack(dir);
    assert.equal(r.code, 0, r.out);
    // with a committed account project, the line says the zip offers sign-in and names the pilot pack
    const signIn = /url: 'https:/.test(COMMITTED) ? ', offers sign-in; the zip without it is npm run pack -- --pilot' : '';
    assert.match(r.out, new RegExp(`^dist/lot-current-extension-${VERSION.replace(/\./g, '\\.')}\\.zip: \\d+ files, \\d+ KB \\(Lot Current ${VERSION.replace(/\./g, '\\.')}${signIn.replace(/[-.]/g, '\\$&')}\\)$`, 'm'));
    assert.deepEqual(readdirSync(join(dir, 'dist')), [`lot-current-extension-${VERSION}.zip`], 'one zip, the normal one');
    const src = join(dir, 'extension');
    const want = zip(walk(src).map((name) => ({ name, data: readFileSync(join(src, name)) })));
    assert.ok(readFileSync(join(dir, NORMAL)).equals(want), 'the normal zip is extension/ as it is, byte for byte');
    const config = readZip(readFileSync(join(dir, NORMAL)), true).find((e) => e.name === 'src/accountConfig.js');
    assert.equal(config.data.toString('utf8'), COMMITTED, 'the normal zip carries the committed account config');
    // a pilot pack afterwards leaves the normal zip as it was
    assert.equal(pack(dir, '--pilot').code, 0);
    assert.ok(readFileSync(join(dir, NORMAL)).equals(want));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--pilot writes the -pilot zip: the normal zip\'s entries, in order and byte for byte, except src/accountConfig.js', async () => {
  const dir = copy();
  try {
    assert.equal(pack(dir).code, 0);
    const r = pack(dir, '--pilot');
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(join(dir, PILOT)), `${PILOT} was not written:\n${r.out}`);
    assert.match(r.out, new RegExp(`^dist/lot-current-extension-${VERSION.replace(/\./g, '\\.')}-pilot\\.zip: \\d+ files`, 'm'));
    assert.match(r.out, /no sign-in/i, 'the pack says what the pilot zip leaves out');
    const normal = readZip(readFileSync(join(dir, NORMAL)), true);
    const pilot = readZip(readFileSync(join(dir, PILOT)), true);
    assert.deepEqual(pilot.map((e) => e.name), normal.map((e) => e.name), 'the same files in the same order');
    const differ = pilot.filter((e, i) => !e.data.equals(normal[i].data)).map((e) => e.name);
    assert.deepEqual(differ, ['src/accountConfig.js'], 'only the account config differs');
    // the packed config, loaded as a module, gives accounts off and keeps the export shape
    const text = pilot.find((e) => e.name === 'src/accountConfig.js').data.toString('utf8');
    const mod = await load(text);
    assert.deepEqual(Object.keys(mod).sort(), ['ACCOUNT', 'accountsConfigured']);
    assert.ok(Object.isFrozen(mod.ACCOUNT));
    assert.deepEqual({ ...mod.ACCOUNT }, { url: '', anonKey: '', functionsUrl: '' });
    assert.equal(mod.accountsConfigured(), false);
    assert.equal(mod.accountsConfigured({ url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'sb_publishable_x' }), true, 'the check itself is the committed one');
    // the comments are kept, plus one line that says what this copy is
    const added = text.split('\n').filter((l) => !COMMITTED.split('\n').includes(l));
    assert.equal(added.filter((l) => l.startsWith('//')).length, 1, `one added comment line:\n${added.join('\n')}`);
    assert.match(added.find((l) => l.startsWith('//')), /packed for a pilot without accounts/i);
    for (const line of COMMITTED.split('\n').filter((l) => l.startsWith('//'))) assert.ok(text.includes(line), `the comment "${line}" is kept`);
    const project = /^ {2}url: '([^']+)',$/m.exec(COMMITTED);
    if (project) assert.ok(!text.includes(project[1]), 'the committed project\'s address is nowhere in the pilot copy');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pilot pack never writes the committed account config, not even for a moment', () => {
  const dir = copy();
  try {
    const file = join(dir, 'extension/src/accountConfig.js');
    const before = { bytes: readFileSync(file), mtimeMs: statSync(file).mtimeMs, ctimeMs: statSync(file).ctimeMs };
    assert.equal(pack(dir, '--pilot').code, 0);
    const after = statSync(file);
    assert.ok(readFileSync(file).equals(before.bytes), 'the bytes are the same');
    assert.equal(after.mtimeMs, before.mtimeMs, 'never rewritten and put back');
    assert.equal(after.ctimeMs, before.ctimeMs, 'not touched at all');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // and the pack's source writes nothing but the zip it names
  const src = read('scripts/pack.mjs');
  const writes = [...src.matchAll(/\b(writeFileSync|appendFileSync|renameSync|copyFileSync|rmSync|unlinkSync|writeFile|cpSync)\s*\(([^,)]*)/g)].map((m) => `${m[1]}(${m[2]}`);
  assert.deepEqual(writes, ['writeFileSync(target'], 'one write, of the zip');
});

test('the pilot pack refuses, writing no pilot zip, when the committed config no longer has the shape it rewrites', () => {
  const changes = [
    ['a fourth value', (t) => t.replace("  functionsUrl: '',\n", "  functionsUrl: '',\n  region: 'us-east-1',\n")],
    ['a value that is not a plain string', (t) => t.replace(/^ {2}anonKey: '[^']*',$/m, '  anonKey: globalThis.KEY,')],
    ['no Object.freeze', (t) => t.replace('Object.freeze({', '({')],
    // a check that answers false in Node, where the pack loads it, and true in the extension
    ['a check that reads the browser', (t) => t.replace(/^export const accountsConfigured = .*$/m, 'export const accountsConfigured = (config = ACCOUNT) => Boolean(globalThis.chrome && globalThis.chrome.runtime) || Boolean(config && config.url && config.anonKey);')],
  ];
  for (const [what, change] of changes) {
    const dir = copy();
    try {
      const file = join(dir, 'extension/src/accountConfig.js');
      const changed = change(COMMITTED);
      assert.notEqual(changed, COMMITTED, what);
      writeFileSync(file, changed);
      const r = pack(dir, '--pilot');
      assert.equal(r.code, 1, `${what}: refused\n${r.out}`);
      assert.match(r.out, /src\/accountConfig\.js/, `${what}: the message names the file`);
      assert.match(r.out, /shape/, `${what}: and says the shape changed`);
      assert.ok(!existsSync(join(dir, PILOT)), `${what}: no pilot zip`);
      assert.equal(readFileSync(file, 'utf8'), changed, `${what}: the file is left as it was`);
      assert.equal(pack(dir).code, 0, `${what}: the normal pack still works`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// The pack does not trust the rewrite: it loads the copy it is about to
// write as a module and refuses unless that gives accounts off. A rewrite
// that went wrong (here, scripts/pilot-config.mjs changed in the temporary
// copy) must stop the pack with nothing written, the same as a shape change.
test('the pilot pack loads the rewritten copy before it writes, and refuses one that would leave accounts on', () => {
  const wrong = [
    ['a rewrite that keeps the values', (s) => s.replace(`block.replace(VALUE, "$1'',")`, 'block'), /ACCOUNT\.url is "[^"]+", not empty[\s\S]*accountsConfigured\(\) gives true, not false/],
    ['a rewrite that empties the values but answers true', (s) => s.replace(`text.replace(BLOCK, (block) => block.replace(VALUE, "$1'',"));`, `text.replace(BLOCK, (block) => block.replace(VALUE, "$1'',")).replace(/=> Boolean\\(.*\\);$/m, '=> true;');`), /accountsConfigured\(\) gives true, not false/],
  ];
  for (const [what, change, reason] of wrong) {
    const dir = copy();
    try {
      const script = join(dir, 'scripts/pilot-config.mjs');
      const source = readFileSync(script, 'utf8');
      const changed = change(source);
      assert.notEqual(changed, source, `${what}: scripts/pilot-config.mjs no longer has the line this test changes`);
      writeFileSync(script, changed);
      const r = pack(dir, '--pilot');
      assert.equal(r.code, 1, `${what}: refused\n${r.out}`);
      assert.match(r.out, /would not turn accounts off/, `${what}: the message says why`);
      assert.match(r.out, reason, `${what}: and what the loaded copy gave`);
      assert.match(r.out, /Nothing was packed/, what);
      assert.ok(!existsSync(join(dir, PILOT)), `${what}: no pilot zip`);
      assert.ok(!existsSync(join(dir, 'dist')), `${what}: nothing written at all`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('the pack refuses an option it does not know, and --pilot typed without the --, so a slip never gives a zip with sign-in', () => {
  const dir = copy();
  try {
    const r = pack(dir, '--pliot');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /--pliot/);
    assert.match(r.out, /--pilot/, 'it names the option it takes');
    assert.ok(!existsSync(join(dir, 'dist')), 'nothing written');
    // npm run pack --pilot, without the --: npm keeps --pilot as its own
    // setting (npm_config_pilot "true"; --no-pilot gives "") and the script
    // gets no option at all. That must not quietly give the zip with sign-in.
    for (const value of ['true', '']) {
      const slip = packWithEnv(dir, { npm_config_pilot: value });
      assert.equal(slip.code, 1, `npm_config_pilot=${JSON.stringify(value)}: refused\n${slip.out}`);
      assert.match(slip.out, /npm run pack -- --pilot/, 'it says how to ask for the pilot zip');
      assert.match(slip.out, /Nothing was packed/);
      assert.ok(!existsSync(join(dir, 'dist')), `npm_config_pilot=${JSON.stringify(value)}: nothing written`);
    }
    // with the -- as well, the script sees --pilot and packs the pilot zip
    const both = packWithEnv(dir, { npm_config_pilot: 'true' }, '--pilot');
    assert.equal(both.code, 0, both.out);
    assert.deepEqual(readdirSync(join(dir, 'dist')), [`lot-current-extension-${VERSION}-pilot.zip`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the rewrite is a pure function: the values emptied, the comments kept, one line added, the shape checked', async () => {
  const { pilotAccountConfig, PILOT_LINE } = await import('../scripts/pilot-config.mjs');
  const out = pilotAccountConfig(COMMITTED);
  assert.equal(pilotAccountConfig(COMMITTED), out, 'the same text every time');
  const before = COMMITTED.split('\n');
  const after = out.split('\n');
  assert.equal(after[0], PILOT_LINE, 'the added line comes first');
  assert.match(PILOT_LINE, /^\/\/ .*packed for a pilot without accounts/i);
  // it claims only what the empty config does: no sign-in, no sync. The
  // rewrite service is still asked at the address the synced profile holds
  // when the writer is on, whatever server that is.
  assert.match(PILOT_LINE, /offers no sign-in and syncs nothing/);
  assert.doesNotMatch(PILOT_LINE, /account server|no request|sends nothing|contacts/i);
  assert.equal(after.length, before.length + 1, 'one line added, none removed');
  const changed = before.map((l, i) => [l, after[i + 1]]).filter(([a, b]) => a !== b);
  assert.ok(changed.length <= 3, 'at most the three value lines change');
  for (const [, line] of changed) assert.match(line, /^ {2}(url|anonKey|functionsUrl): '',$/);
  assert.match(out, /^export const ACCOUNT = Object\.freeze\(\{\n {2}url: '',\n {2}anonKey: '',\n {2}functionsUrl: '',\n\}\);$/m);
  // a Windows checkout's CRLF endings are kept
  const crlf = pilotAccountConfig(COMMITTED.replace(/\n/g, '\r\n'));
  assert.equal(crlf, out.replace(/\n/g, '\r\n'));
  // an already empty config is rewritten the same way (and still gives accounts off)
  const empty = COMMITTED.replace(/^( {2}(?:url|anonKey|functionsUrl): )'[^']*',$/gm, "$1'',");
  assert.equal(pilotAccountConfig(empty), out);
});

test('the rewrite refuses a config whose shape it does not know, and says what changed', async () => {
  const { pilotAccountConfig, PILOT_LINE } = await import('../scripts/pilot-config.mjs');
  const refusals = [
    ['a fourth value', COMMITTED.replace("  functionsUrl: '',\n", "  functionsUrl: '',\n  region: '',\n")],
    ['a template literal', COMMITTED.replace(/^ {2}url: '[^']*',$/m, '  url: `https://x.supabase.co`,')],
    ['a value read from elsewhere', COMMITTED.replace(/^ {2}anonKey: '[^']*',$/m, '  anonKey: globalThis.KEY,')],
    ['the values in another order', COMMITTED.replace(/^( {2}url: '[^']*',)\n( {2}anonKey: '[^']*',)$/m, '$2\n$1')],
    ['no freeze', COMMITTED.replace('Object.freeze({', '({')],
    ['a second export', `${COMMITTED}export const EXTRA = 1;\n`],
    ['an import', `import { x } from './x.js';\n${COMMITTED}`],
    ['no accountsConfigured', COMMITTED.replace(/^export const accountsConfigured = .*$/m, '')],
    // the check itself must be the committed line: a body that answers true,
    // or one that answers differently in a browser than in Node (where the
    // pack loads it), is a shape change like a change to ACCOUNT
    ['a check that answers true', COMMITTED.replace(/^export const accountsConfigured = .*$/m, 'export const accountsConfigured = () => true;')],
    ['a check that reads the browser', COMMITTED.replace(/^export const accountsConfigured = .*$/m, 'export const accountsConfigured = (config = ACCOUNT) => Boolean(globalThis.chrome && globalThis.chrome.runtime) || Boolean(config && config.url && config.anonKey);')],
    // and nothing but comments around the two exports, so no helper can change what the check means
    ['a helper the check would call', COMMITTED.replace(/^export const accountsConfigured = /m, 'function Boolean(x) { return globalThis.chrome ? true : !!x; }\nexport const accountsConfigured = ')],
    ['a statement between the exports', COMMITTED.replace(/^export const accountsConfigured = /m, 'globalThis.LOT_CURRENT_ACCOUNTS = true;\nexport const accountsConfigured = ')],
    ['code after a carriage return in a comment', `${COMMITTED}// a note\rfunction Boolean() { return true; }\n`],
    ['code after a line separator in a comment', `${COMMITTED}// a note\u2028function Boolean() { return true; }\n`],
    ['a block comment', `/* a note */\n${COMMITTED}`],
    ['a copy already packed for a pilot', `${PILOT_LINE}\n${COMMITTED}`],
    ['nothing', ''],
  ];
  for (const [what, text] of refusals) {
    assert.throws(() => pilotAccountConfig(text), (e) => /accountConfig\.js/.test(e.message) && /shape/.test(e.message), what);
  }
});

test('the check loads the rewritten module and refuses anything but accounts off', async () => {
  const { pilotAccountConfig, accountsOffProblems } = await import('../scripts/pilot-config.mjs');
  assert.deepEqual(await accountsOffProblems(pilotAccountConfig(COMMITTED)), []);
  // the committed file names the production project: it is not a pilot config
  if (/url: 'https:/.test(COMMITTED)) assert.match((await accountsOffProblems(COMMITTED)).join('\n'), /ACCOUNT\.url is "https:[^"]+", not empty[\s\S]*accountsConfigured\(\) gives true, not false/);
  const off = pilotAccountConfig(COMMITTED);
  const broken = [
    [off.replace("functionsUrl: '',", "functionsUrl: 'https://fn.example.test',"), /ACCOUNT\.functionsUrl is "https:\/\/fn\.example\.test", not empty/],
    [off.replace(/=> Boolean\(.*\);$/m, '=> true;'), /accountsConfigured\(\) gives true, not false/],
    [off.replace('Object.freeze({', '({'), /ACCOUNT is not a frozen object/],
    [`${off}export const EXTRA = 1;\n`, /exports ACCOUNT, EXTRA, accountsConfigured/],
    [off.replace('export const ACCOUNT', 'export const ACCOUNTS'), /exports ACCOUNTS, accountsConfigured[\s\S]*ACCOUNT is not a frozen object/],
    [off.replace(/^export const accountsConfigured = .*$/m, 'export const accountsConfigured = 1;'), /accountsConfigured is not a function/],
    ['export const ACCOUNT = Object.freeze({ url: \'\'', /does not load as a module/],
  ];
  for (const [text, re] of broken) assert.match((await accountsOffProblems(text)).join('\n'), re);
});

test('CI packs the pilot zip too, before store-check, so every push checks it', () => {
  const ci = read('.github/workflows/ci.yml');
  const job = ci.slice(ci.indexOf('\n  pack:\n'), ci.indexOf('\n  # ', ci.indexOf('\n  pack:\n')));
  const at = (line) => job.indexOf(`\n      - run: ${line}\n`);
  assert.ok(at('npm run pack') > 0, 'the pack job packs');
  assert.ok(at('npm run pack -- --pilot') > at('npm run pack'), 'then the pilot zip');
  assert.ok(at('npm run store-check') > at('npm run pack -- --pilot'), 'then checks both');
  // and the wizard flow's job runs set-up on the pilot zip as well (no Account step)
  const e2e = ci.slice(ci.indexOf('\n  e2e:\n'), ci.indexOf('\n  demo:\n'));
  const step = e2e.indexOf("\n      - if: matrix.flow == 'wizard'\n        run: npm run pack -- --pilot && npm run test:e2e:wizard -- --zip \"$(ls dist/*-pilot.zip)\"\n");
  assert.ok(step > e2e.indexOf('\n      - run: npm run test:e2e:${{ matrix.flow }}\n'), 'the wizard job runs set-up on the pilot zip after the flow itself');
});

// Who gets which zip, where a tester or the owner reads it: testers on a
// pilot without accounts get the pilot zip, the store gets the normal one.
test('the install steps, the pilot runbook and the store steps say which zip goes where', () => {
  const pilotZip = '`lot-current-extension-<version>-pilot.zip`';
  const readme = read('README.md');
  const install = readme.slice(readme.indexOf('## Install'), readme.indexOf('## Use'));
  assert.ok(install.includes(pilotZip) && /no sign-in/.test(install), 'README\'s install names the pilot zip and that it has no sign-in');
  assert.match(install, /pilot zip and the normal zip are the same extension/, 'and that one replaces the other in the same folder');
  const help = read('docs/help.md');
  const helpInstall = help.slice(help.indexOf('### Install'), help.indexOf('## Set up'));
  assert.ok(helpInstall.includes(pilotZip) && /no sign-in/.test(helpInstall), 'the help\'s install names the pilot zip');
  assert.match(help, /"Accounts are not set up yet", as it does in the pilot zip, this step is not shown/);
  const pilot = read('PILOT.md');
  const before = pilot.slice(pilot.indexOf('### Before every pilot'), pilot.indexOf('## During the pilot'));
  assert.ok(before.includes(`gets the pilot zip, ${pilotZip} (\`npm run pack -- --pilot\``), 'PILOT.md hands pilot salespeople the pilot zip');
  assert.match(before, /With the pilot zip there is nothing to skip/);
  assert.match(read('store/submission.md'), /upload `dist\/lot-current-extension-<version>\.zip`, never the `-pilot\.zip` beside it/);
  assert.match(read('store/listing.md'), /the zip in `dist\/` without `-pilot` in its name is what the dashboard takes/);
  assert.match(read('docs/data-inventory.md'), /every build made from it offers sign-in, except the pilot zip \(`npm run pack -- --pilot`\), whose copy of that file is empty/);
});
