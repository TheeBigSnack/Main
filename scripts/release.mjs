#!/usr/bin/env node
// Lot Current release: one command, so every version ships the same way
// (docs/release.md has the whole checklist).
//
//   npm run release -- 0.6.0             that version
//   npm run release -- patch             0.5.0 -> 0.5.1 (minor: 0.6.0, major: 1.0.0)
//   npm run release -- minor --dry-run   print what would change, write nothing
//
// Before it writes anything it refuses when:
//   - git status shows a change outside CHANGELOG.md and README.md (the two
//     files a person edits for a release; everything that ships is committed);
//   - the new version is not greater than the current one, or the three
//     version stamps disagree;
//   - CHANGELOG.md has no "## <new version> (" heading, or it is not the newest,
//     or "## Unreleased" is missing, below it or still holds entries (they
//     ship in this version: rename "## Unreleased" to the new heading and put
//     a new, empty "## Unreleased" above it);
//   - README.md's title does not carry the new major.minor (test/docs.test.js).
// Then it writes the version into extension/manifest.json, package.json and
// both places in package-lock.json (a text edit, so formatting and key order
// stay), runs the unit tests and `npm run pack`, and prints the next steps.
// If the tests or the pack fail, it puts the three files back as they were.
//
// It never commits, tags, pushes or uploads: a person does, from the steps it
// prints. It runs the three commands in COMMANDS and nothing else.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Every command this script may run. git status --porcelain only reads.
export const COMMANDS = Object.freeze({
  status: Object.freeze(['git', 'status', '--porcelain']),
  test: Object.freeze(['npm', 'test']),
  pack: Object.freeze(['npm', 'run', 'pack']),
});

export const VERSION_FILES = Object.freeze(['extension/manifest.json', 'package.json', 'package-lock.json']);
// The release's own words, written by a person before the run and committed with the version.
export const RELEASE_NOTES = Object.freeze(['CHANGELOG.md', 'README.md']);

// Chrome takes at most 65535 in each part of a manifest version.
const MAX_PART = 65535;

export function parseVersion(s) {
  if (typeof s !== 'string') return null;
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(s);
  if (!m) return null;
  const [major, minor, patch] = m.slice(1).map(Number);
  if (major > MAX_PART || minor > MAX_PART || patch > MAX_PART) return null;
  return { major, minor, patch };
}

export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`cannot compare "${a}" and "${b}": a version is x.y.z`);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
  return 0;
}

// The next version: 'patch', 'minor', 'major' or an explicit x.y.z that must be greater.
export function bump(current, kind) {
  const v = parseVersion(current);
  if (!v) throw new Error(`the current version "${current}" is not x.y.z`);
  let next;
  if (kind === 'patch') next = `${v.major}.${v.minor}.${v.patch + 1}`;
  else if (kind === 'minor') next = `${v.major}.${v.minor + 1}.0`;
  else if (kind === 'major') next = `${v.major + 1}.0.0`;
  else if (parseVersion(kind)) next = kind;
  else throw new Error(`"${kind}" is not patch, minor, major or a version like 0.6.0`);
  if (!parseVersion(next)) throw new Error(`${next} is past Chrome's limit of ${MAX_PART} in a version part`);
  if (compareVersions(next, current) <= 0) throw new Error(`${next} is not greater than the current version ${current}`);
  return next;
}

// The top-level "version" at two-space (or tab) indent, and the root package's
// entry in a lockfile. npm writes both this way; anything else is refused.
const TOP_VERSION = /^((?: {2}|\t)"version"\s*:\s*")[^"\n]*(")/m;
const ROOT_PACKAGE_VERSION = /("packages"\s*:\s*\{\s*""\s*:\s*\{[^{}]*?"version"\s*:\s*")[^"\n]*(")/;

function replaceValue(text, re, value, what) {
  const m = re.exec(text);
  if (!m) throw new Error(`no ${what} to change`);
  return text.slice(0, m.index) + m[1] + value + m[2] + text.slice(m.index + m[0].length);
}

// The file's text with the new version, for manifest.json, package.json and
// package-lock.json (both places). Only the version values change; the result
// is checked against the parsed original so nothing else can.
export function setVersionText(text, version) {
  if (!parseVersion(version)) throw new Error(`"${version}" is not x.y.z`);
  const before = JSON.parse(text);
  if (typeof before.version !== 'string') throw new Error('the file has no top-level "version"');
  const lock = typeof before.lockfileVersion === 'number';
  let out = replaceValue(text, TOP_VERSION, version, 'top-level "version"');
  if (lock) {
    if (!before.packages || !before.packages[''] || typeof before.packages[''].version !== 'string') throw new Error('the lockfile has no packages[""].version');
    out = replaceValue(out, ROOT_PACKAGE_VERSION, version, 'packages[""].version');
  }
  const want = structuredClone(before);
  want.version = version;
  if (lock) want.packages[''].version = version;
  if (JSON.stringify(JSON.parse(out)) !== JSON.stringify(want)) throw new Error('the edit would change more than the version');
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "## 0.6.0 (" at the start of a line, the CHANGELOG's heading format.
export function changelogHasVersion(text, version) {
  return new RegExp(`^## ${escapeRe(version)} \\(`, 'm').test(text);
}

export function newestChangelogVersion(text) {
  const m = /^## (\d+\.\d+\.\d+) \(/m.exec(text);
  return m ? m[1] : null;
}

// What stops CHANGELOG.md from describing `version`: no "## <version> (" heading,
// a newer one above it, or a "## Unreleased" section that is missing, below
// the new heading or still holds entries (they shipped in this version and
// belong under its heading). The empty "## Unreleased" stays on top for the
// next changes; test/brandName.test.js reads it. [] when the log is ready.
export function changelogProblems(text, version) {
  const heading = `"## ${version} (<date>, <what it is>)"`;
  const unreleased = /^## Unreleased[ \t]*$/m.exec(text);
  if (!changelogHasVersion(text, version)) {
    return [unreleased
      ? `CHANGELOG.md has no "## ${version} (" heading. Rename "## Unreleased" to ${heading}, then put a new, empty "## Unreleased" above it.`
      : `CHANGELOG.md has no "## ${version} (" heading. Write ${heading} at the top, above ${newestChangelogVersion(text) || 'the others'}, with an empty "## Unreleased" above it.`];
  }
  const problems = [];
  if (newestChangelogVersion(text) !== version) problems.push(`CHANGELOG.md's newest heading is ${newestChangelogVersion(text)}; put the ${version} entry at the top, under "## Unreleased".`);
  if (!unreleased) {
    problems.push(`CHANGELOG.md has no "## Unreleased" heading; put an empty one above "## ${version} (" for the changes after this release (test/brandName.test.js reads it).`);
    return problems;
  }
  const versionAt = new RegExp(`^## ${escapeRe(version)} \\(`, 'm').exec(text).index;
  const next = text.indexOf('\n## ', unreleased.index + 1);
  const pending = text.slice(unreleased.index + unreleased[0].length, next < 0 ? undefined : next).trim();
  if (pending) problems.push(`CHANGELOG.md's "## Unreleased" still holds entries, which ship in ${version}: move them under "## ${version} (" (or rename "## Unreleased" to ${heading}) and leave an empty "## Unreleased" on top.`);
  else if (versionAt < unreleased.index) problems.push(`CHANGELOG.md's "## Unreleased" sits below "## ${version} (": move the empty "## Unreleased" to the top.`);
  return problems;
}

// test/docs.test.js wants the README to open with the shipped major.minor.
export function readmeTitle(version) {
  const v = parseVersion(version);
  return `# Lot Current (v${v.major}.${v.minor})`;
}

export function readmeTitleFits(text, version) {
  return text.startsWith(readmeTitle(version));
}

// Paths git status --porcelain lists that are not the release's own notes.
export function dirtyPaths(porcelain) {
  return porcelain.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.slice(3)).filter((p) => !RELEASE_NOTES.includes(p));
}

// The checklist under "## Before submitting" in store/listing.md, one line per box.
export function submitSteps(listing) {
  const start = listing.search(/^## Before submitting\s*$/m);
  if (start < 0) return [];
  const rest = listing.slice(start).split('\n').slice(1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).filter((l) => /^- \[[ x]\] /.test(l)).map((l) => l.replace(/^- \[[ x]\] /, ''));
}

// The same name scripts/pack.mjs writes.
export const zipPath = (version) => `dist/lot-current-extension-${version}.zip`;

// The account project a build talks to: the url in extension/src/accountConfig.js,
// or '' while that config is empty.
export function accountUrlIn(text) {
  const m = /^\s*url: '([^']*)',/m.exec(String(text || ''));
  return m ? m[1] : '';
}

// What a build that names an account project must wait for, in one place so
// docs/release.md can quote it.
export const ACCOUNT_GATE = 'docs/production-setup.md steps 3 to 5 done and npm run check-deploy showing no FAIL';

// Lines whose text differs between two versions of a file (the edit keeps the line count).
export function changedLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  return a.map((line, i) => ({ line: i + 1, from: line.trim(), to: (b[i] ?? '').trim() })).filter((d) => d.from !== d.to);
}

// What a person does after the script: printed, never run.
export function nextSteps({ version, listing, accountUrl = '' }) {
  const zip = zipPath(version);
  const boxes = submitSteps(listing || '');
  const lines = [
    `Lot Current ${version} is packed: ${zip}`,
    'Nothing was committed, tagged, pushed or uploaded. Next, by hand (docs/release.md):',
    '',
    // a build that names the account project offers sign-in, which works only once that project is set up
    ...(accountUrl ? [
      `This build names the account project ${accountUrl} (extension/src/accountConfig.js), so the wizard and Settings offer sign-in.`,
      `Hand it to no tester and upload it nowhere before ${ACCOUNT_GATE}: until then that sign-in cannot work.`,
      '',
    ] : []),
    '1. The end-to-end flows and the sandbox drive, with Playwright\'s Chromium (README, "For development"):',
    '     npm run test:e2e',
    '     npm run test:demo',
    '2. Commit and tag the release:',
    `     git add ${[...RELEASE_NOTES, ...VERSION_FILES].join(' ')}`,
    `     git commit -m "Release ${version}"`,
    `     git tag -a v${version} -m "Lot Current ${version}"`,
    '     git push --follow-tags',
    `3. Upload ${zip} in the Chrome Web Store Developer Dashboard: Lot Current, Package, Upload new package, then Submit for review.`,
    '   Visibility stays Unlisted for the pilot and the design partners; Public only after the review passes and the owner says so.',
  ];
  if (boxes.length) {
    lines.push('   Before the first submission, every box in store/listing.md, "Before submitting":');
    for (const b of boxes) lines.push(`     - ${b}`);
  } else {
    lines.push('   Before the first submission, every box in store/listing.md, "Before submitting".');
  }
  lines.push('4. Testers on the zip get the same file; README, "Update", says how to replace the files and reload.');
  return lines;
}

export function parseArgs(argv) {
  const out = { target: null, dryRun: false, help: false };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a.startsWith('-')) return { error: `unknown option ${a}` };
    else if (out.target) return { error: `one version at a time (got ${out.target} and ${a})` };
    else out.target = a;
  }
  if (!out.target && !out.help) return { error: 'which version? a number like 0.6.0, or patch, minor or major' };
  return out;
}

const USAGE = [
  'Usage: npm run release -- <x.y.z | patch | minor | major> [--dry-run]',
  '  npm run release -- 0.6.0',
  '  npm run release -- patch --dry-run',
];

// The listing is only printed from: a missing file must not stop a release after the pack.
function listingText(io) {
  try {
    return io.read('store/listing.md');
  } catch {
    return '';
  }
}

// Likewise the account config, read only to say what the build talks to.
function accountUrlOf(io) {
  try {
    return accountUrlIn(io.read('extension/src/accountConfig.js'));
  } catch {
    return '';
  }
}

// The whole release. io: { read(rel), write(rel, text), exists(rel), run(cmd) -> { code, stdout }, log(s), error(s) }.
// Returns the exit code.
export function release(argv, io) {
  const args = parseArgs(argv);
  if (args.help) { io.log(USAGE.join('\n')); return 0; }
  if (args.error) { io.error(`release: ${args.error}\n${USAGE.join('\n')}`); return 1; }
  if (args.dryRun) io.log('Dry run: nothing will be written.');

  const texts = Object.fromEntries(VERSION_FILES.map((f) => [f, io.read(f)]));
  const stamps = VERSION_FILES.map((f) => [f, JSON.parse(texts[f]).version]);
  const lock = JSON.parse(texts['package-lock.json']);
  stamps.push(['package-lock.json packages[""]', lock.packages && lock.packages[''] && lock.packages[''].version]);
  const current = stamps[0][1];
  if (stamps.some(([, v]) => v !== current)) {
    io.error(`release: the version stamps disagree (${stamps.map(([f, v]) => `${f} ${v}`).join(', ')}); make them equal first (test/manifest.test.js).`);
    return 1;
  }
  let version;
  try {
    version = bump(current, args.target);
  } catch (e) {
    io.error(`release: ${e.message}.`);
    return 1;
  }

  const problems = [];
  const status = io.run(COMMANDS.status);
  if (status.code !== 0) {
    problems.push('git status failed: run this from a clone of the repository.');
  } else {
    const dirty = dirtyPaths(status.stdout);
    if (dirty.length) problems.push(`uncommitted changes outside ${RELEASE_NOTES.join(' and ')}: ${dirty.slice(0, 10).join(', ')}${dirty.length > 10 ? ` and ${dirty.length - 10} more` : ''}. Commit or put them aside first, so the zip is what the tag holds.`);
  }
  const changelog = io.read('CHANGELOG.md');
  problems.push(...changelogProblems(changelog, version));
  const readme = io.read('README.md');
  if (!readmeTitleFits(readme, version)) problems.push(`README.md does not open with "${readmeTitle(version)}" (test/docs.test.js checks it); change its title first.`);
  if (problems.length) {
    io.error(`release: not releasing ${version}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    return 1;
  }

  let next;
  try {
    next = Object.fromEntries(VERSION_FILES.map((f) => [f, setVersionText(texts[f], version)]));
  } catch (e) {
    io.error(`release: ${e.message}; nothing was written.`);
    return 1;
  }

  if (args.dryRun) {
    io.log(`${current} -> ${version}. The lines that would change:`);
    for (const f of VERSION_FILES) {
      for (const d of changedLines(texts[f], next[f])) io.log(`  ${f}:${d.line}  ${d.from}  ->  ${d.to}`);
    }
    io.log(`Then it would run ${COMMANDS.test.join(' ')} and ${COMMANDS.pack.join(' ')}, and print:\n`);
    io.log(nextSteps({ version, listing: listingText(io), accountUrl: accountUrlOf(io) }).join('\n'));
    return 0;
  }

  const restore = (why) => {
    for (const f of VERSION_FILES) io.write(f, texts[f]);
    io.error(`release: ${why}; ${VERSION_FILES.join(', ')} are back at ${current}.`);
    return 1;
  };
  for (const f of VERSION_FILES) io.write(f, next[f]);
  io.log(`${current} -> ${version} in ${VERSION_FILES.join(', ')} (both places in the lockfile).`);
  if (io.run(COMMANDS.test).code !== 0) return restore('the unit tests failed at the new version');
  if (io.run(COMMANDS.pack).code !== 0) return restore('npm run pack failed');
  if (!io.exists(zipPath(version))) return restore(`npm run pack did not write ${zipPath(version)}`);
  io.log('');
  io.log(nextSteps({ version, listing: listingText(io), accountUrl: accountUrlOf(io) }).join('\n'));
  return 0;
}

// The one place a command runs, and only one from COMMANDS.
export function runCommand(cmd, spawn = spawnSync) {
  const allowed = Object.values(COMMANDS).some((c) => c.length === cmd.length && c.every((part, i) => part === cmd[i]));
  if (!allowed) throw new Error(`release.mjs runs only ${Object.values(COMMANDS).map((c) => c.join(' ')).join(', ')}; not ${cmd.join(' ')}`);
  const [bin, ...args] = cmd;
  const capture = bin === 'git';
  // npm on Windows is a .cmd file that Node starts only through a shell; when npm
  // started this script it named its own entry point, which this Node can run.
  const npmCli = bin === 'npm' && /\.c?js$/.test(process.env.npm_execpath || '') ? process.env.npm_execpath : null;
  const file = npmCli ? process.execPath : bin;
  const argv = npmCli ? [npmCli, ...args] : args;
  const r = spawn(file, argv, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: bin === 'npm' && !npmCli && process.platform === 'win32',
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  return { code: r.status ?? 1, stdout: r.stdout || '' };
}

function realIo() {
  const at = (rel) => join(root, rel);
  return {
    read: (rel) => readFileSync(at(rel), 'utf8'),
    write: (rel, text) => writeFileSync(at(rel), text),
    exists: (rel) => existsSync(at(rel)),
    run: (cmd) => runCommand(cmd),
    log: (s) => console.log(s),
    error: (s) => console.error(s),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2);
  // `npm run release 0.6.0 --dry-run` (no --) hands --dry-run to npm, not to
  // this script; npm's own dry-run setting counts as a dry run here too.
  if (process.env.npm_config_dry_run === 'true' && !argv.includes('--dry-run')) argv.push('--dry-run');
  process.exitCode = release(argv, realIo());
}
