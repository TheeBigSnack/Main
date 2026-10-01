// scripts/release.mjs: the version rules, the text edit on real copies of
// the three stamped files (read here, never written), the refusals before
// anything is written, and that the script runs only git status, npm test
// and npm run pack: committing, tagging, pushing and uploading stay with a person.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COMMANDS, VERSION_FILES, parseVersion, compareVersions, bump, setVersionText, changelogHasVersion, newestChangelogVersion,
  readmeTitle, readmeTitleFits, dirtyPaths, submitSteps, zipPath, changedLines, nextSteps, parseArgs, release, runCommand,
  accountUrlIn, ACCOUNT_GATE,
} from '../scripts/release.mjs';
import { ACCOUNT, accountsConfigured } from '../extension/src/accountConfig.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const REAL = Object.fromEntries([...VERSION_FILES, 'CHANGELOG.md', 'README.md', 'store/listing.md'].map((f) => [f, read(f)]));
const CURRENT = JSON.parse(REAL['extension/manifest.json']).version;

test('parseVersion takes x.y.z and nothing else', () => {
  assert.deepEqual(parseVersion('0.5.0'), { major: 0, minor: 5, patch: 0 });
  assert.deepEqual(parseVersion('12.0.65535'), { major: 12, minor: 0, patch: 65535 });
  for (const bad of ['0.6', 'v0.6.0', '0.6.0-beta', '01.2.3', '1.2.3.4', ' 0.6.0', '', '1.65536.0', undefined, 6]) {
    assert.equal(parseVersion(bad), null, `${JSON.stringify(bad)} is not a version`);
  }
});

test('versions compare by number, not by text', () => {
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('0.5.0', '0.5.0'), 0);
  assert.equal(compareVersions('0.5.0', '1.0.0'), -1);
});

test('bump: patch, minor, major, or a greater version named outright', () => {
  assert.equal(bump('0.5.0', 'patch'), '0.5.1');
  assert.equal(bump('0.5.3', 'minor'), '0.6.0');
  assert.equal(bump('0.5.3', 'major'), '1.0.0');
  assert.equal(bump('0.5.0', '0.6.0'), '0.6.0');
  assert.equal(bump('0.9.0', '0.10.0'), '0.10.0');
  assert.throws(() => bump('0.5.0', '0.5.0'), /not greater than the current version 0\.5\.0/);
  assert.throws(() => bump('0.5.0', '0.4.9'), /not greater/);
  assert.throws(() => bump('0.5.0', 'v0.6.0'), /not patch, minor, major or a version/);
  assert.throws(() => bump('0.5', 'patch'), /current version "0\.5" is not x\.y\.z/);
  assert.throws(() => bump('0.5.65535', 'patch'), /Chrome's limit/);
});

test('setVersionText changes the manifest version and nothing else', () => {
  const text = REAL['extension/manifest.json'];
  const out = setVersionText(text, '9.8.7');
  assert.equal(JSON.parse(out).version, '9.8.7');
  const diff = changedLines(text, out);
  assert.equal(diff.length, 1, 'one line');
  assert.match(diff[0].to, /^"version": "9\.8\.7",?$/);
  assert.deepEqual(Object.keys(JSON.parse(out)), Object.keys(JSON.parse(text)), 'key order kept');
  assert.equal(out.length, text.length, 'same length for a same-length version: no reformatting');
  assert.equal(out.replace('"9.8.7"', `"${CURRENT}"`), text);
});

test('setVersionText changes package.json\'s version and leaves the scripts and the rest as written', () => {
  const text = REAL['package.json'];
  const out = setVersionText(text, '9.8.7');
  assert.equal(JSON.parse(out).version, '9.8.7');
  assert.equal(changedLines(text, out).length, 1);
  assert.equal(out.replace('"9.8.7"', `"${CURRENT}"`), text);
  assert.equal(out.endsWith('\n'), text.endsWith('\n'), 'the last newline kept');
});

test('setVersionText changes both places in package-lock.json and no dependency\'s version', () => {
  const text = REAL['package-lock.json'];
  const out = setVersionText(text, '9.8.7');
  const lock = JSON.parse(out);
  assert.equal(lock.version, '9.8.7');
  assert.equal(lock.packages[''].version, '9.8.7');
  const diff = changedLines(text, out);
  assert.equal(diff.length, 2, 'the top-level version and packages[""]');
  const before = JSON.parse(text);
  for (const [name, entry] of Object.entries(before.packages)) {
    if (name) assert.equal(lock.packages[name].version, entry.version, `${name} kept its version`);
  }
  assert.equal(out.split('"9.8.7"').join(`"${CURRENT}"`), text);
});

test('setVersionText refuses a bad version, a file without one and a lockfile it cannot edit exactly', () => {
  assert.throws(() => setVersionText(REAL['package.json'], '0.6'), /not x\.y\.z/);
  assert.throws(() => setVersionText('{\n  "name": "x"\n}\n', '0.6.0'), /no top-level "version"/);
  // a nested "version" is not the top-level one; an edit that would touch it is refused
  const nested = setVersionText('{\n  "a": {\n    "version": "1.0.0"\n  },\n  "version": "1.0.0"\n}\n', '2.0.0');
  assert.deepEqual(JSON.parse(nested), { a: { version: '1.0.0' }, version: '2.0.0' });
  assert.throws(() => setVersionText('{\n  "a": {\n  "version": "1.0.0"\n  },\n  "version": "1.0.0"\n}\n', '2.0.0'), /more than the version/);
  assert.throws(() => setVersionText('{"version":"1.0.0"}', '2.0.0'), /no top-level "version" to change/, 'not the format npm writes');
  assert.throws(() => setVersionText('{\n  "version": "0.5.0",\n  "lockfileVersion": 3,\n  "packages": {}\n}\n', '0.6.0'), /packages\[""\]\.version/);
});

test('changelogHasVersion finds the "## x.y.z (" heading and nothing else', () => {
  const log = REAL['CHANGELOG.md'];
  assert.ok(changelogHasVersion(log, CURRENT), `the real CHANGELOG has ${CURRENT}`);
  assert.ok(changelogHasVersion(log, '0.4.0'));
  assert.equal(changelogHasVersion(log, '99.0.0'), false);
  assert.equal(changelogHasVersion('## 0x5x0 (today)', '0.5.0'), false, 'the dots are literal');
  assert.equal(changelogHasVersion('Since 0.6.0 (the tab)\n### 0.6.0 (x)', '0.6.0'), false, 'a mention or a smaller heading is not the entry');
  assert.equal(changelogHasVersion('## 0.6.0\n', '0.6.0'), false, 'the heading carries its date in brackets');
  assert.equal(newestChangelogVersion(log), CURRENT, 'the shipped version is the newest entry');
});

test('the README title check matches test/docs.test.js', () => {
  const [major, minor] = CURRENT.split('.');
  assert.equal(readmeTitle(CURRENT), `# Lot Current (v${major}.${minor})`);
  assert.ok(readmeTitleFits(REAL['README.md'], CURRENT));
  assert.ok(readmeTitleFits(REAL['README.md'], bump(CURRENT, 'patch')), 'a patch keeps the title');
  assert.equal(readmeTitleFits(REAL['README.md'], bump(CURRENT, 'minor')), false);
});

test('dirtyPaths lets the release notes through and nothing else', () => {
  assert.deepEqual(dirtyPaths(''), []);
  assert.deepEqual(dirtyPaths(' M CHANGELOG.md\n M README.md\n'), []);
  assert.deepEqual(dirtyPaths(' M CHANGELOG.md\r\n M README.md\r\n'), [], 'Windows line ends');
  assert.deepEqual(dirtyPaths(' M CHANGELOG.md\n?? notes.txt\nM  extension/popup.js\nR  a.md -> README.md\n'), ['notes.txt', 'extension/popup.js', 'a.md -> README.md']);
});

test('the zip name is the one scripts/pack.mjs writes, and the upload steps come from store/listing.md', () => {
  assert.equal(zipPath('0.6.0'), 'dist/lot-current-extension-0.6.0.zip');
  assert.ok(read('scripts/pack.mjs').includes("join(root, 'dist', `lot-current-extension-${manifest.version}.zip`)"), 'pack.mjs changed the zip name: change zipPath too');
  const boxes = submitSteps(REAL['store/listing.md']);
  assert.ok(boxes.length >= 3, 'store/listing.md has a "Before submitting" checklist');
  assert.ok(boxes.some((b) => b.includes('npm run pack')));
  assert.ok(boxes.some((b) => /Unlisted/.test(b)));
  assert.deepEqual(submitSteps('# x\n## Before submitting\n\n- [ ] one\n- [x] two\n## Next\n- [ ] not this\n'), ['one', 'two']);
  assert.deepEqual(submitSteps('no such section'), []);
});

test('the next steps print the commit, tag and upload for a person to run', () => {
  const text = nextSteps({ version: '0.6.0', listing: REAL['store/listing.md'] }).join('\n');
  assert.match(text, /Nothing was committed, tagged, pushed or uploaded/);
  assert.match(text, /npm run test:e2e/);
  assert.match(text, /npm run test:demo/);
  assert.match(text, /git add CHANGELOG\.md README\.md extension\/manifest\.json package\.json package-lock\.json/);
  assert.match(text, /git commit -m "Release 0\.6\.0"/);
  assert.match(text, /git tag -a v0\.6\.0 -m "Lot Current 0\.6\.0"/);
  assert.match(text, /git push --follow-tags/);
  assert.match(text, /Upload dist\/lot-current-extension-0\.6\.0\.zip/);
  assert.match(text, /Unlisted/);
  assert.match(text, /Before submitting/);
});

test('parseArgs: one version, --dry-run, nothing unknown', () => {
  assert.deepEqual(parseArgs(['0.6.0']), { target: '0.6.0', dryRun: false, help: false });
  assert.deepEqual(parseArgs(['--dry-run', 'patch']), { target: 'patch', dryRun: true, help: false });
  assert.match(parseArgs([]).error, /which version/);
  assert.match(parseArgs(['0.6.0', '0.7.0']).error, /one version at a time/);
  assert.match(parseArgs(['0.6.0', '--force']).error, /unknown option --force/);
});

// A repository in memory: the real texts, a git status, and npm answers.
function world({ status = '', changelogEntry = null, readme = REAL['README.md'], testCode = 0, packCode = 0, packWrites = true } = {}) {
  const files = { ...REAL, 'README.md': readme };
  if (changelogEntry) files['CHANGELOG.md'] = REAL['CHANGELOG.md'].replace('# Changelog\n\n', `# Changelog\n\n## ${changelogEntry} (2026-10-01, a test entry)\n\nChanged\n- Nothing.\n\n`);
  const runs = [];
  const writes = [];
  const out = [];
  const err = [];
  const io = {
    read: (rel) => {
      if (!(rel in files)) throw new Error(`read ${rel}`);
      return files[rel];
    },
    write: (rel, text) => { writes.push(rel); files[rel] = text; },
    exists: (rel) => packWrites && runs.some((c) => c === COMMANDS.pack) && rel === zipPath(JSON.parse(files['extension/manifest.json']).version),
    run: (cmd) => {
      runs.push(cmd);
      if (cmd === COMMANDS.status) return { code: 0, stdout: status };
      if (cmd === COMMANDS.test) return { code: testCode, stdout: '' };
      if (cmd === COMMANDS.pack) return { code: packCode, stdout: '' };
      throw new Error(`ran ${cmd.join(' ')}`);
    },
    log: (s) => out.push(s),
    error: (s) => err.push(s),
  };
  return { io, files, runs, writes, out: () => out.join('\n'), err: () => err.join('\n') };
}

test('a dirty tree is refused before anything is written or run', () => {
  const next = bump(CURRENT, 'patch');
  const w = world({ status: ' M extension/popup.js\n?? scratch.txt\n M CHANGELOG.md\n', changelogEntry: next });
  assert.equal(release(['patch'], w.io), 1);
  assert.deepEqual(w.writes, []);
  assert.deepEqual(w.runs, [COMMANDS.status]);
  assert.match(w.err(), /uncommitted changes outside CHANGELOG\.md and README\.md: extension\/popup\.js, scratch\.txt\./);
  // the dry run refuses the same way
  const d = world({ status: ' M package.json\n', changelogEntry: next });
  assert.equal(release(['patch', '--dry-run'], d.io), 1);
  assert.deepEqual(d.writes, []);
  assert.match(d.out(), /Dry run/, 'the person sees the flag took effect');
});

test('a version without its CHANGELOG entry is refused, and so is one that is not the newest or not greater', () => {
  const w = world();
  assert.equal(release(['patch'], w.io), 1);
  assert.deepEqual(w.writes, []);
  assert.ok(!w.runs.includes(COMMANDS.test) && !w.runs.includes(COMMANDS.pack));
  assert.match(w.err(), new RegExp(`CHANGELOG\\.md has no "## ${bump(CURRENT, 'patch').replace(/\./g, '\\.')} \\(" heading`));

  const older = world({ changelogEntry: bump(CURRENT, 'patch') });
  older.files['CHANGELOG.md'] = older.files['CHANGELOG.md'].replace(`## ${bump(CURRENT, 'patch')} (`, '## 0.0.1 (');
  older.files['CHANGELOG.md'] += `\n## ${bump(CURRENT, 'patch')} (2026-10-01, at the bottom)\n`;
  assert.equal(release(['patch'], older.io), 1);
  assert.match(older.err(), /put the .* entry at the top/);

  const same = world();
  assert.equal(release([CURRENT], same.io), 1);
  assert.match(same.err(), /not greater than the current version/);
  assert.deepEqual(same.writes, []);
  assert.deepEqual(same.runs, [], 'refused before git status');
});

test('a new minor without the README title is refused; with it, the release goes through', () => {
  const next = bump(CURRENT, 'minor');
  const w = world({ changelogEntry: next });
  assert.equal(release(['minor'], w.io), 1);
  assert.match(w.err(), new RegExp(`README\\.md does not open with "# Lot Current \\(v${next.split('.').slice(0, 2).join('\\.')}\\)"`));
  assert.deepEqual(w.writes, []);
  const ok = world({ status: ' M CHANGELOG.md\n M README.md\n', changelogEntry: next, readme: REAL['README.md'].replace(readmeTitle(CURRENT), readmeTitle(next)) });
  assert.equal(release(['minor'], ok.io), 0, ok.err());
});

test('the version stamps must agree before a release', () => {
  const w = world({ changelogEntry: bump(CURRENT, 'patch') });
  w.files['package.json'] = setVersionText(REAL['package.json'], '0.0.9');
  assert.equal(release(['patch'], w.io), 1);
  assert.match(w.err(), /version stamps disagree/);
  assert.deepEqual(w.writes, []);
});

test('--dry-run prints each line it would change and writes nothing', () => {
  const next = bump(CURRENT, 'patch');
  const w = world({ changelogEntry: next });
  assert.equal(release(['patch', '--dry-run'], w.io), 0, w.err());
  assert.deepEqual(w.writes, []);
  assert.deepEqual(w.runs, [COMMANDS.status], 'no tests, no pack');
  const out = w.out();
  assert.match(out, /^Dry run: nothing will be written\./);
  assert.ok(out.includes(`${CURRENT} -> ${next}. The lines that would change:`));
  for (const f of ['extension/manifest.json', 'package.json']) assert.equal(out.split('\n').filter((l) => l.startsWith(`  ${f}:`)).length, 1, f);
  assert.equal(out.split('\n').filter((l) => l.startsWith('  package-lock.json:')).length, 2);
  assert.ok(out.includes(`"version": "${next}"`));
  assert.match(out, /git tag -a v/);
});

test('a release writes the three files, runs the tests and the pack, then prints the steps', () => {
  const next = bump(CURRENT, 'patch');
  const w = world({ status: ' M CHANGELOG.md\n', changelogEntry: next });
  assert.equal(release(['patch'], w.io), 0, w.err());
  assert.deepEqual(w.writes, VERSION_FILES);
  assert.deepEqual(w.runs, [COMMANDS.status, COMMANDS.test, COMMANDS.pack]);
  assert.equal(JSON.parse(w.files['extension/manifest.json']).version, next);
  assert.equal(JSON.parse(w.files['package.json']).version, next);
  const lock = JSON.parse(w.files['package-lock.json']);
  assert.equal(lock.version, next);
  assert.equal(lock.packages[''].version, next);
  assert.ok(w.out().includes(`Lot Current ${next} is packed: ${zipPath(next)}`));
  assert.match(w.out(), /Nothing was committed, tagged, pushed or uploaded/);
});

test('failing tests or a failed pack put the three files back', () => {
  const next = bump(CURRENT, 'patch');
  for (const opts of [{ testCode: 1 }, { packCode: 1 }, { packWrites: false }]) {
    const w = world({ changelogEntry: next, ...opts });
    assert.equal(release(['patch'], w.io), 1);
    for (const f of VERSION_FILES) assert.equal(w.files[f], REAL[f], `${f} restored (${JSON.stringify(opts)})`);
    assert.match(w.err(), new RegExp(`are back at ${CURRENT.replace(/\./g, '\\.')}`));
    assert.doesNotMatch(w.out(), /is packed/);
  }
});

test('the script never commits, tags, pushes or reaches the network: three commands, one runner', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(COMMANDS)), { status: ['git', 'status', '--porcelain'], test: ['npm', 'test'], pack: ['npm', 'run', 'pack'] });
  assert.ok(Object.isFrozen(COMMANDS) && Object.values(COMMANDS).every(Object.isFrozen), 'the list cannot grow at run time');
  // the runner refuses anything else before it starts a process
  const spawned = [];
  const spawn = (file, args) => { spawned.push([file, ...args]); return { status: 0, stdout: '' }; };
  for (const cmd of [['git', 'commit', '-m', 'x'], ['git', 'tag', 'v1.0.0'], ['git', 'push'], ['git', 'status'], ['npm', 'publish'], ['curl', 'https://example.com']]) {
    assert.throws(() => runCommand(cmd, spawn), /runs only/, cmd.join(' '));
  }
  assert.deepEqual(spawned, []);
  runCommand(['git', 'status', '--porcelain'], spawn);
  assert.deepEqual(spawned, [['git', 'status', '--porcelain']]);
  // and the source has no other way to run anything or reach a network
  const src = read('scripts/release.mjs');
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['node:child_process', 'node:fs', 'node:path', 'node:url']);
  assert.match(src, /^import \{ spawnSync \} from 'node:child_process';$/m, 'spawnSync alone from child_process');
  assert.equal(src.match(/\bspawnSync\b/g).length, 2, 'spawnSync is imported and handed to runCommand, nowhere else');
  for (const re of [/\b(execSync|execFile|execFileSync|fork)\s*\(/, /\bfetch\s*\(/, /\beval\s*\(/, /new Function/, /\bimport\s*\(/, /process\.binding/]) {
    assert.doesNotMatch(src, re, `release.mjs matches ${re}`);
  }
  // every git or npm command in the source outside COMMANDS is printed text for a person
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  const runs = [...code.matchAll(/\brun\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(runs.length >= 3);
  for (const arg of runs) assert.match(arg, /^(COMMANDS\.(status|test|pack)|cmd)$/, `run(${arg})`);
});

// A build whose extension/src/accountConfig.js names a project offers sign-in
// in the wizard and Settings, which works only once that project's database,
// functions and sign-in email are set up. The release says so before the
// upload and the testers' copy, and says nothing while the config is empty.
test('the next steps say when a build names the account project, and what it waits for', () => {
  assert.equal(accountUrlIn(read('extension/src/accountConfig.js')), ACCOUNT.url, 'the url the extension uses');
  assert.equal(accountUrlIn("export const ACCOUNT = Object.freeze({\n  url: '',\n  anonKey: '',\n});"), '');
  const url = 'https://abcdefghijklmnopqrst.supabase.co';
  const named = nextSteps({ version: '0.6.0', listing: '', accountUrl: url }).join('\n');
  assert.ok(named.includes(`names the account project ${url} (extension/src/accountConfig.js)`));
  assert.ok(named.includes(ACCOUNT_GATE));
  assert.ok(named.indexOf(ACCOUNT_GATE) < named.indexOf('3. Upload') && named.indexOf(ACCOUNT_GATE) < named.indexOf('4. Testers'), 'before the upload and the testers');
  assert.doesNotMatch(nextSteps({ version: '0.6.0', listing: '' }).join('\n'), /account project/);
  // the run reads the real config: today it names the production project
  const next = bump(CURRENT, 'patch');
  const w = world({ changelogEntry: next });
  w.files['extension/src/accountConfig.js'] = read('extension/src/accountConfig.js');
  assert.equal(release(['patch', '--dry-run'], w.io), 0, w.err());
  assert.equal(w.out().includes(ACCOUNT_GATE), accountsConfigured());
  // the release checklist and the config's own header say the same
  assert.ok(read('docs/release.md').includes(`before \`docs/production-setup.md\` steps 3 to 5 are done and \`npm run check-deploy\` shows no FAIL`));
  const header = read('extension/src/accountConfig.js').split('export const')[0];
  assert.match(header, /With url and anonKey filled, accountsConfigured\(\) is true: the\n\/\/ first-run wizard has its optional Account step/);
  assert.match(header, /steps 3 to 5/);
  assert.doesNotMatch(header, /until then every value is empty/, 'the header no longer says the shipped values are empty');
  assert.doesNotMatch(read('extension/src/wizardSteps.js'), /the shipped empty config/);
});
