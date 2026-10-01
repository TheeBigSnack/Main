// The Chrome Web Store preflight (scripts/store-check.mjs): the store's own
// limits on the manifest, no code from outside the package, every module the
// extension loads is in it, the packed zip equals extension/, the listing's
// placeholders and pending answers reported as "not ready", and the images'
// sizes. The last test runs it over the repository itself: nothing may be
// wrong now, whatever is still waiting for the owner or the attorney.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS, checkImages, checkListing, checkManifest, compareZip, findMissingReferences, findRemoteCode,
  configuredSupportEmail, findStrayFiles, iconMargin, jpegSize, pngOpaqueBox, placeholders, pngSize, readZip, runChecks, section, validVersion,
} from '../scripts/store-check.mjs';
import { zip } from '../scripts/pack.mjs';
import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { SITE } from '../site/config.js';

const root = new URL('..', import.meta.url).pathname;

// A real 8-bit RGBA PNG, transparent except a box `pad` pixels in from each
// edge, each row with a different filter so the decoder's every branch runs.
function rgbaPng(size, pad, { type = 6, depth = 8, extra = [] } = {}) {
  const rows = [];
  let prev = Buffer.alloc(size * 4);
  for (let y = 0; y < size; y++) {
    const line = Buffer.alloc(size * 4);
    for (let x = 0; x < size; x++) if (x >= pad && x < size - pad && y >= pad && y < size - pad) line.set([20, 83, 45, 255], x * 4);
    const filter = y % 5;
    const out = Buffer.alloc(size * 4);
    for (let i = 0; i < out.length; i++) {
      const a = i >= 4 ? line[i - 4] : 0, b = prev[i], c = i >= 4 ? prev[i - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      out[i] = (line[i] - pred) & 0xff;
    }
    rows.push(Buffer.from([filter]), out);
    prev = line;
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = depth; ihdr[9] = type;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra.map(([t, d]) => chunk(t, d)), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

function png(width, height) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function jpeg(width, height) {
  // SOI, an APP0 segment, then SOF0 with the size
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(9, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(4)]);
}

const base = () => ({
  manifest_version: 3,
  name: 'Example Name',
  version: '1.2.3',
  description: 'Does one thing for you to check.',
  icons: { 16: 'icons/16.png', 128: 'icons/128.png' },
  action: { default_popup: 'popup.html' },
  background: { service_worker: 'bg.js', type: 'module' },
});
const files = (extra = {}) => new Map(Object.entries({
  'manifest.json': Buffer.from('{}'),
  'icons/16.png': png(16, 16),
  'icons/128.png': rgbaPng(128, 16),
  'popup.html': Buffer.from('<script type="module" src="popup.js"></script>'),
  'popup.js': Buffer.from("import { a } from './src/a.js';\n"),
  'src/a.js': Buffer.from('export const a = 1;\n'),
  'bg.js': Buffer.from("// eval( in a comment is prose\nimport './src/a.js';\n"),
  ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v)])),
}));

test('version numbers the store takes', () => {
  for (const v of ['1', '0.5.0', '1.2.3.4', '65535.0.0']) assert.ok(validVersion(v), v);
  for (const v of ['', '1.2.3.4.5', '01.0', '1.65536', '1.0-beta', 'v1', '1..2', undefined]) assert.ok(!validVersion(v), String(v));
});

test('a manifest within the limits, with its files present, passes', () => {
  assert.deepEqual(checkManifest(base(), files()).failures, []);
});

test('the store limits on name, short name, description and version fail the check', () => {
  const m = { ...base(), name: 'N'.repeat(LIMITS.name + 1), short_name: 'S'.repeat(13), description: 'D'.repeat(133), version: '1.0-beta', manifest_version: 2 };
  const f = checkManifest(m, files()).failures.join('\n');
  for (const re of [/name is 76 characters/, /short_name is 13/, /description is 133/, /version "1\.0-beta"/, /Manifest V3/]) assert.match(f, re);
  assert.match(checkManifest({ ...base(), name: 'N'.repeat(LIMITS.name) }, files()).failures.join('\n'), /^$/);
});

test('a missing file, a wrong icon size and a CSP that lets code in are failures', () => {
  const m = { ...base(), side_panel: { default_path: 'panel.html' }, content_security_policy: { extension_pages: "script-src 'self' https://cdn.example.com" } };
  const f = checkManifest(m, files({ 'icons/128.png': png(96, 96) })).failures.join('\n');
  assert.match(f, /side_panel\.default_path names panel\.html/);
  assert.match(f, /icons\.128 \(icons\/128\.png\) is 96 x 96/);
  assert.match(f, /content_security_policy/);
  assert.match(checkManifest({ ...base(), icons: { 16: 'icons/16.png' } }, files()).failures.join('\n'), /128 x 128 icon/);
  assert.deepEqual(checkManifest({ ...base(), content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'" } }, files()).failures, []);
});

test('code from outside the package is found, data requests and comments are not', () => {
  const bad = files({
    'a.html': '<script src="https://cdn.example.com/x.js"></script><link rel="stylesheet" href="//fonts.example.com/a.css">',
    'b.js': "import x from 'https://esm.example.com/x.js';\nconst y = await import(name);\neval('1');\nnew Function('return 1');\nsetTimeout('go()', 5);\nimportScripts('w.js');\nwindow.eval(s); globalThis.eval(s);\nexport * from 'https://cdn.example.com/m.js';\nconst f = Function('return 1');",
  });
  const f = findRemoteCode(bad).join('\n');
  for (const re of [/a\.html:1: a <script> from another host/, /a\.html:1: a stylesheet/, /b\.js:1: an import from another host/, /b\.js:2: a dynamic import of a computed address/, /b\.js:3: eval/, /b\.js:4: new Function/, /b\.js:5: a timer/, /b\.js:6: importScripts/, /b\.js:7: eval[\s\S]*b\.js:7: eval/, /b\.js:8: an import from another host/, /b\.js:9: new Function/]) assert.match(f, re);
  // The usual ways to load or run code that do not name eval( or an import.
  const built = findRemoteCode(files({
    'e.js': "const s = document.createElement('script'); s.src = 'https://cdn.example.com/a.js';\nfetch(u).then((r) => r.text()).then(eval);\n(0, eval)(code);\nwindow['eval'](code);\nnew Worker('https://cdn.example.com/w.js');\nconst t = document.createElementNS(ns, \"script\");\n",
  })).join('\n');
  for (const re of [/e\.js:1: a <script> element built in code/, /e\.js:2: eval used as a value/, /e\.js:3: eval used as a value/, /e\.js:4: eval used as a value/, /e\.js:5: a worker from another host/, /e\.js:6: a <script> element built in code/]) assert.match(built, re);
  const fine = files({
    'c.js': "// eval(x) and new Function( in a comment\n/*\n * import('https://x')\n */\nconst r = await fetch('https://api.example.com/v1');\nconst e = obj.evaluate(1); retrieval(2);\nconst m = await import('./src/a.js');\nconst csp = \"script-src 'self' 'wasm-unsafe-eval'\";\nconst div = document.createElement('div');\nconst w = new Worker('./worker.js');\n",
    'd.html': '<!-- <script src="https://x"></script> --><a href="https://example.com">site</a><link rel="icon" href="icons/16.png">',
  });
  assert.deepEqual(findRemoteCode(fine), []);
});

test('every module and page asset the extension loads must be in the package', () => {
  assert.deepEqual(findMissingReferences(files()), []);
  const f = findMissingReferences(files({
    'popup.js': "import { a } from './src/a.js';\nimport { b } from './src/b.js';\nexport { c } from '../c.js';\nconst d = await import('./lazy.js');\n// import './comment-only.js';\n",
    'popup.html': '<script type="module" src="popup.js"></script><link rel="stylesheet" href="popup.css"><img src="icons/missing.png" alt="">',
  })).join('\n');
  for (const name of ['./src/b.js', '../c.js', './lazy.js', 'popup.css', 'icons/missing.png']) assert.ok(f.includes(`loads ${name}`), name);
  assert.ok(!f.includes('comment-only'));
  assert.ok(!f.includes('./src/a.js'));
});

test('source maps, keys, tests and dependencies do not belong in the package', () => {
  const f = findStrayFiles(files({ 'popup.js.map': '{}', 'key.pem': 'x', 'test/a.test.js': '', 'node_modules/x/i.js': '', '.env': 'K=1' })).join('\n');
  for (const name of ['popup.js.map', 'key.pem', 'test/a.test.js', 'node_modules/x/i.js', '.env']) assert.ok(f.includes(name), name);
  assert.deepEqual(findStrayFiles(files()), []);
});

test('the zip pack.mjs writes reads back with the same files and bytes', () => {
  const fs = files();
  const entries = [...fs].map(([name, data]) => ({ name, data }));
  const back = readZip(zip(entries), true);
  assert.deepEqual(back.map((e) => e.name), [...fs.keys()]);
  assert.deepEqual(compareZip(back, fs), []);
  // a missing file, an extra file and a stale copy are each named
  const stale = entries.filter((e) => e.name !== 'src/a.js').map((e) => (e.name === 'bg.js' ? { name: e.name, data: Buffer.from('old') } : e));
  stale.push({ name: 'extra.txt', data: Buffer.from('x') });
  const f = compareZip(readZip(zip(stale), true), fs).join('\n');
  assert.match(f, /missing src\/a\.js/);
  assert.match(f, /holds extra\.txt/);
  assert.match(f, /bg\.js differs/);
  assert.throws(() => readZip(Buffer.from('not a zip at all, longer than twenty-two bytes')), /not a zip/);
  assert.throws(() => readZip(Buffer.from('tiny')), /not a zip/);
  assert.match(compareZip([{ name: 'manifest.json', data: null }], new Map([['manifest.json', Buffer.from('{}')]])).join('\n'), /compression this check cannot read/);
});

test('the store icon\'s transparent margin is read from the pixels', () => {
  assert.deepEqual(pngOpaqueBox(rgbaPng(128, 16)), { minX: 16, minY: 16, maxX: 111, maxY: 111 });
  assert.equal(iconMargin(rgbaPng(128, 16)), 16);
  assert.equal(iconMargin(rgbaPng(128, 0)), 0);
  assert.equal(iconMargin(png(128, 128)), 0, 'no pixels to read: treated as edge to edge');
  const tight = checkManifest(base(), files({ 'icons/128.png': rgbaPng(128, 4) })).failures.join('\n');
  assert.match(tight, /4px from the edge/);
  assert.deepEqual(checkManifest(base(), files({ 'icons/128.png': rgbaPng(128, 12) })).failures, []);
  // a palette icon with tRNS (what PNG optimisers write) and a 16-bit icon are not measured, not failed
  for (const odd of [rgbaPng(128, 16, { type: 3, extra: [['PLTE', Buffer.alloc(3)], ['tRNS', Buffer.from([0])]] }), rgbaPng(128, 16, { depth: 16 })]) {
    assert.equal(iconMargin(odd), null);
    const r = checkManifest(base(), files({ 'icons/128.png': odd }));
    assert.deepEqual(r.failures, []);
    assert.match(r.notes.join('\n'), /not measured/);
  }
  // nothing visible is a failure, not a pass
  assert.equal(iconMargin(rgbaPng(128, 64)), 'empty');
  assert.match(checkManifest(base(), files({ 'icons/128.png': rgbaPng(128, 64) })).failures.join('\n'), /no visible pixels/);
});

test('image sizes from PNG and JPEG headers', () => {
  assert.deepEqual(pngSize(png(1280, 800)), { width: 1280, height: 800 });
  assert.deepEqual(jpegSize(jpeg(640, 400)), { width: 640, height: 400 });
  assert.equal(pngSize(Buffer.from('nope')), null);
  assert.equal(jpegSize(png(1, 1)), null);
});

test('screenshots and promo tiles: sizes, count, and the required small tile', () => {
  const promo = [{ file: 'promo-small-440x280.png', buf: png(440, 280) }, { file: 'promo-marquee-1400x560.png', buf: null }];
  const none = checkImages({ screenshots: [], promo });
  assert.deepEqual(none.failures, []);
  assert.match(none.conditions.join('\n'), /no screenshots/);
  const ok = checkImages({ screenshots: [{ name: '1.png', buf: png(1280, 800) }, { name: '2.jpg', buf: jpeg(640, 400) }], promo });
  assert.deepEqual(ok, { failures: [], conditions: [] });
  const bad = checkImages({
    screenshots: [...Array(6)].map((_, i) => ({ name: `${i}.png`, buf: png(1920, 1080) })),
    promo: [{ file: 'promo-small-440x280.png', buf: null }, { file: 'promo-marquee-1400x560.png', buf: png(1400, 500) }],
  }).failures.join('\n');
  assert.match(bad, /6 screenshots/);
  assert.match(bad, /1920 x 1080/);
  assert.match(bad, /small promo tile is required/);
  assert.match(bad, /promo-marquee-1400x560\.png is not a 1400 x 560 PNG/);
});

test('placeholders are brackets, not Markdown links or task boxes', () => {
  assert.deepEqual(placeholders('Mail [support email]. See [the docs](https://x). - [ ] todo - [x] done [Pending attorney answer: 8.1]'), ['[support email]', '[Pending attorney answer: 8.1]']);
});

const LISTING = (extra = {}) => `# Listing

## Item name

Example Name

## Summary

Up to 132 characters.

Does one thing for you to check.

## Detailed description

${extra.detailed ?? 'Plain text. You click Publish.'}

## Test instructions

${extra.tests ?? 'Open the sample site and click Scan.'}

## Support and homepage

${extra.support ?? '- Homepage: https://example.com/'}
`;

test('the listing: name and summary from the manifest, length, code marks, placeholders and the attorney\'s pending answers', () => {
  const manifest = base();
  const done = checkListing({ listing: LISTING(), privacy: 'Answers.', manifest, legalLinks: "termsUrl: 'https://example.com/terms'", legalStatus: { draft: false } });
  assert.deepEqual(done, { failures: [], conditions: [] });

  const f = checkListing({ listing: LISTING({ detailed: 'x'.repeat(LIMITS.detailedDescription + 1) + ' `code`' }).replace('Example Name\n', 'Other\n'), privacy: '', manifest, legalStatus: { draft: false } }).failures.join('\n');
  assert.match(f, /Item name "Other"/);
  assert.match(f, /16001|16008/);
  assert.match(f, /code marks/);
  const spam = checkListing({ listing: LISTING({ detailed: 'Facebook '.repeat(6) + 'Marketplace '.repeat(5) + 'Metadata Meta' }), privacy: '', manifest, legalStatus: { draft: false } }).failures.join('\n');
  assert.match(spam, /names Facebook 6 times/);
  assert.doesNotMatch(spam, /Marketplace|Meta /);
  assert.match(checkListing({ listing: LISTING().replace('## Test instructions', '## Notes'), privacy: '', manifest, legalStatus: { draft: false } }).failures.join('\n'), /no Test instructions/);
  assert.match(checkListing({ listing: LISTING().replace('Does one thing for you to check.', 'Something else.'), privacy: '', manifest, legalStatus: { draft: false } }).failures.join('\n'), /Summary/);

  const c = checkListing({
    listing: LISTING({ detailed: 'Support: [support email].', tests: 'Use [a test account].', support: '- Homepage: https://x.example/ [Pending attorney answer: 8.1]\n- Support: someone@example.com, support@example.com' }),
    privacy: 'DRAFT: for review.\n[Pending attorney answer: 8.2] [Pending attorney answer: 8.3]',
    manifest,
    legalLinks: "termsUrl: 'https://x.example/terms'",
    legalStatus: { draft: true },
  }).conditions.join('\n');
  for (const re of [/detailed description still says \[support email\]/, /test instructions still say \[a test account\]/, /Support and homepage still names \.example/, /legalLinks\.js/, /legal-status\.json/, /listing\.md has 1 "\[Pending/, /privacy\.md has 2 "\[Pending/, /marked DRAFT/, /names someone@example\.com, not a support inbox/]) assert.match(c, re);
  assert.doesNotMatch(c, /names support@example\.com/);
  // the inbox site/config.js names is the owner's confirmed one: strict passes with it on the listing; any other address still stops it
  const owner = { listing: LISTING({ support: '- Support: owner@lotcurrent.com and stray@lotcurrent.com' }), privacy: 'Answers.', manifest, legalLinks: "termsUrl: 'https://example.com/terms'", legalStatus: { draft: false } };
  assert.deepEqual(checkListing({ ...owner, supportEmail: 'Owner@lotcurrent.com' }).conditions, ['Support and homepage names stray@lotcurrent.com, not a support inbox: put the inbox site/config.js names (supportEmail) or a support@ address there']);
  assert.equal(checkListing(owner).conditions.length, 2, 'with no inbox configured, only support@ addresses pass');
  assert.equal(configuredSupportEmail("export const SITE = {\n  siteUrl: '',\n  supportEmail: 'owner@lotcurrent.com',\n};"), 'owner@lotcurrent.com');
  assert.equal(configuredSupportEmail("export const SITE = {\n  supportEmail: '',\n};"), '');
  assert.equal(configuredSupportEmail(''), '');
});

test('section() reads one "## " section and nothing after it', () => {
  assert.equal(section(LISTING(), 'Item name'), 'Example Name');
  assert.equal(section(LISTING(), 'Nope'), null);
  assert.equal(section('## A\n\none\n\n### sub\n\ntwo\n\n## B\n\nthree', 'A'), 'one\n\n### sub\n\ntwo');
  assert.equal(section('## A\n\none\n\n## B\n\nlast', 'B'), 'last');
});

// zip: false here; CI's pack job runs npm run store-check after npm run pack,
// which is where the packed zip is compared with extension/.
test('the repository itself: nothing wrong with the package or the listing now', () => {
  const { failures, conditions } = runChecks(root, { zip: false });
  assert.deepEqual(failures, [], failures.join('\n'));
  // What is left is the owner's and the attorney's, and the check says so.
  assert.ok(conditions.every((c) => typeof c === 'string' && c.length));
  // the listing's support address is the inbox the website names, which the owner confirmed, so it is not one of them
  if (SITE.supportEmail) assert.ok(section(readFileSync(new URL('../store/listing.md', import.meta.url), 'utf8'), 'Support and homepage').includes(SITE.supportEmail), 'the listing names the support inbox site/config.js names');
  assert.deepEqual(conditions.filter((c) => /^Support and homepage names /.test(c)), [], 'strict mode can pass with the confirmed inbox');
  const before = readFileSync(new URL('../store/listing.md', import.meta.url), 'utf8').split('## Before submitting')[1] || '';
  assert.match(before, /- \[ \] The support address [^\n]*receives mail/, 'what the check cannot see, the mailbox, is a box on the list');
});

test('the remote-code answer says what store-check scans for, not that it catches every form', () => {
  const doc = readFileSync(new URL('../store/submission.md', import.meta.url), 'utf8');
  const row = doc.split('\n').find((l) => l.startsWith('| Are you using remote code?'));
  assert.ok(row, 'store/submission.md has the remote-code row');
  assert.doesNotMatch(row, /\b(?:fails on|catches|finds) (?:any|every|all)\b/i, 'a source-text scan cannot promise to catch every form');
  assert.match(row, /cannot catch every form/);
  // the review-risk table says the same, not that the check settles it
  const risk = doc.split('\n').find((l) => l.startsWith('| Remote code, obfuscation'));
  assert.ok(risk, 'store/submission.md has the remote-code review risk');
  assert.match(risk, /cannot catch every one/);
  const f = findRemoteCode(new Map([['x.js', Buffer.from("const s = document.createElement('script');\n")]]));
  assert.equal(f.length, 1, 'a script element built in code, which the answer names, is caught');
});
