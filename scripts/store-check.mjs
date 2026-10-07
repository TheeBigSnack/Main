// The Chrome Web Store preflight: everything about the package and the
// listing that can be checked before a person opens the Developer Dashboard.
// Plain Node, no dependencies, no browser. It reads; it never uploads,
// submits or changes a file.
//
// Run:  npm run store-check              -> the report; exit 1 on a failure
//       npm run store-check -- --strict  -> exit 1 also while anything
//                                           still stands between the repo
//                                           and a submission
//
// Two kinds of finding, like the website generator's:
// - a failure is something wrong now (a manifest field over the store's
//   limit, a file the manifest names that is missing, code fetched from
//   another host, a zip that differs from extension/, an image of the wrong
//   size). `npm test` and CI keep these at zero.
//
// The zips it reads are this version's in dist/: the normal one
// (npm run pack), which is the one the store upload takes, and, when
// present, the pilot zip (npm run pack -- --pilot), which is for testers
// while the pilot runs signed out and never goes to the store. The pilot
// zip must equal extension/ except src/accountConfig.js, which must be what
// the pilot pack makes of the committed file and must give
// accountsConfigured() false once loaded (scripts/pilot-config.mjs).
// - a condition is something not done yet that a submission needs (the
//   [bracketed] placeholders, the attorney's pending answers, the draft
//   legal pages, the placeholder legal addresses, the real screenshots).
//   They are expected today and listed so the owner sees what is left.
//
// The limits are the store's own (store/submission.md has the sources):
// manifest name at most 75 characters, short_name 12, description 132,
// version one to four dot-separated whole numbers 0 to 65535 without
// leading zeros; screenshots 1280 x 800 or 640 x 400, one to five; the small promo tile
// 440 x 280 and the marquee 1400 x 560. Two are this repo's own guards, not
// published limits: the detailed description at most 16,000 characters (the
// figure commonly quoted; the store documents none), and no other company's
// name more than 5 times in it (the store's keyword-spam guidance counts
// repeated keywords and brand names).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { PILOT_CONFIG_PATH, pilotAccountConfig, accountsOffProblems } from './pilot-config.mjs';

export const LIMITS = Object.freeze({
  name: 75,
  shortName: 12,
  description: 132,
  detailedDescription: 16000,
  screenshots: 5,
  packageBytes: 2 * 1024 * 1024 * 1024,
});
export const THIRD_PARTY_NAMES = Object.freeze(['Facebook', 'Marketplace', 'Meta', 'Google', 'Chrome', 'Dealer Inspire', 'Cars Commerce', 'Carfax', 'NHTSA']);
export const MAX_NAME_REPEATS = 5;
export const SCREENSHOT_SIZES = Object.freeze(['1280x800', '640x400']);
export const PROMO = Object.freeze([
  Object.freeze({ file: 'promo-small-440x280.png', width: 440, height: 280, required: true }),
  Object.freeze({ file: 'promo-marquee-1400x560.png', width: 1400, height: 560, required: false }),
]);

// Files a packed extension must not carry (kept equal to scripts/pack.mjs).
export const SKIP = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|.*\.swp|.*~)$/;

export function pngSize(buf) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!Buffer.isBuffer(buf) || buf.length < 24 || !buf.subarray(0, 8).equals(signature) || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// The box around a PNG's visible pixels (alpha above 8), for 8-bit RGBA or
// grey-and-alpha images without interlacing. An RGB or grey PNG without a
// tRNS chunk has no transparency, so the whole image counts. Any other kind
// (a palette or 16-bit image, interlaced, or with tRNS) is not measured:
// { unmeasured: true }. null when not a PNG or nothing is visible.
export function pngOpaqueBox(buf) {
  const size = pngSize(buf);
  if (!size) return null;
  const { width, height } = size;
  const whole = { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1 };
  const depth = buf[24];
  const type = buf[25];
  const interlace = buf[28];
  const channels = type === 6 ? 4 : type === 4 ? 2 : 0;
  const chunks = [];
  for (let p = 8; p + 8 <= buf.length;) {
    const len = buf.readUInt32BE(p);
    chunks.push(buf.toString('ascii', p + 4, p + 8));
    p += 12 + len;
  }
  if (!channels) return (type === 0 || type === 2) && !chunks.includes('tRNS') ? whole : { unmeasured: true };
  if (depth !== 8 || interlace !== 0) return { unmeasured: true };
  const idat = [];
  for (let p = 8; p + 8 <= buf.length;) {
    const len = buf.readUInt32BE(p);
    const kind = buf.toString('ascii', p + 4, p + 8);
    if (kind === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    if (kind === 'IEND') break;
    p += 12 + len;
  }
  let raw;
  try { raw = inflateSync(Buffer.concat(idat)); } catch { return { unmeasured: true }; }
  if (raw.length < height * (stride0(width, channels) + 1)) return { unmeasured: true };
  const stride = stride0(width, channels);
  let prev = Buffer.alloc(stride);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = (line[i] + add) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      if (line[x * channels + channels - 1] > 8) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    prev = line;
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

function stride0(width, channels) { return width * channels; }

// The store icon's padding: the guidance asks for 96 x 96 artwork with 16
// transparent pixels around it. A margin under 12 (a circle-ish mark may come
// closer than a square one) is called out.
export const ICON_MIN_MARGIN = 12;
// The margin in pixels; 'empty' when nothing is visible; null when not a PNG
// or a kind pngOpaqueBox does not measure.
export function iconMargin(buf) {
  const size = pngSize(buf);
  if (!size) return null;
  const box = pngOpaqueBox(buf);
  if (!box) return 'empty';
  if (box.unmeasured) return null;
  return Math.min(box.minX, box.minY, size.width - 1 - box.maxX, size.height - 1 - box.maxY);
}

// JPEG width and height from the first start-of-frame marker.
export function jpegSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const length = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    i += 2 + length;
  }
  return null;
}

export function imageSize(name, buf) {
  return /\.png$/i.test(name) ? pngSize(buf) : /\.jpe?g$/i.test(name) ? jpegSize(buf) : null;
}

export function validVersion(v) {
  if (typeof v !== 'string') return false;
  const parts = v.split('.');
  return parts.length >= 1 && parts.length <= 4 && parts.every((p) => /^(0|[1-9]\d{0,4})$/.test(p) && Number(p) <= 65535);
}

// Every file the manifest names, with where it is named.
export function manifestFiles(m) {
  const out = [];
  const add = (path, where) => { if (typeof path === 'string' && path) out.push({ path: path.replace(/^\//, ''), where }); };
  for (const [size, p] of Object.entries(m.icons || {})) add(p, `icons.${size}`);
  for (const [size, p] of Object.entries(m.action?.default_icon || {})) add(p, `action.default_icon.${size}`);
  add(m.action?.default_popup, 'action.default_popup');
  add(m.background?.service_worker, 'background.service_worker');
  add(m.side_panel?.default_path, 'side_panel.default_path');
  add(m.options_page, 'options_page');
  add(m.options_ui?.page, 'options_ui.page');
  for (const [i, cs] of (m.content_scripts || []).entries()) {
    for (const p of cs.js || []) add(p, `content_scripts[${i}].js`);
    for (const p of cs.css || []) add(p, `content_scripts[${i}].css`);
  }
  return out;
}

// files: Map of package path -> Buffer. Returns { failures, notes }.
export function checkManifest(m, files) {
  const failures = [];
  const notes = [];
  if (m.manifest_version !== 3) failures.push(`manifest_version is ${m.manifest_version}; the store takes only Manifest V3`);
  if (typeof m.name !== 'string' || !m.name.trim()) failures.push('the manifest has no name');
  else if (m.name.length > LIMITS.name) failures.push(`the name is ${m.name.length} characters; the limit is ${LIMITS.name}`);
  if (m.short_name && m.short_name.length > LIMITS.shortName) failures.push(`short_name is ${m.short_name.length} characters; the limit is ${LIMITS.shortName}`);
  if (typeof m.description !== 'string' || !m.description.trim()) failures.push('the manifest has no description (it is the listing summary)');
  else if (m.description.length > LIMITS.description) failures.push(`the description is ${m.description.length} characters; the limit is ${LIMITS.description}`);
  if (!validVersion(m.version)) failures.push(`version "${m.version}" is not one to four dot-separated numbers from 0 to 65535 without leading zeros`);
  if (m.version_name) notes.push(`version_name "${m.version_name}" is what people see instead of the version`);
  if (!m.icons?.['128']) failures.push('no 128 x 128 icon in icons: the store and the install dialog need it');
  for (const { path, where } of manifestFiles(m)) {
    if (!files.has(path)) { failures.push(`${where} names ${path}, which is not in the package`); continue; }
    const size = /^icons\.(\d+)$|^action\.default_icon\.(\d+)$/.exec(where);
    if (size) {
      const px = Number(size[1] || size[2]);
      const dims = pngSize(files.get(path));
      if (!dims) failures.push(`${where} (${path}) is not a PNG`);
      else if (dims.width !== px || dims.height !== px) failures.push(`${where} (${path}) is ${dims.width} x ${dims.height}, not ${px} x ${px}`);
    }
  }
  const icon = m.icons?.['128'] && files.get(m.icons['128'].replace(/^\//, ''));
  if (icon && pngSize(icon)) {
    const margin = iconMargin(icon);
    if (margin === 'empty') failures.push('the 128 x 128 icon has no visible pixels');
    else if (margin === null) notes.push('the 128 x 128 icon\'s margin was not measured (a palette, 16-bit or interlaced PNG): check it by eye');
    else if (margin < ICON_MIN_MARGIN) failures.push(`the 128 x 128 icon's artwork comes ${margin}px from the edge; the store's guidance is 96 x 96 artwork with 16 transparent pixels around it (node scripts/extension-icon.mjs)`);
  }
  const csp = m.content_security_policy;
  const cspText = typeof csp === 'string' ? csp : Object.values(csp || {}).join(' ');
  if (/unsafe-eval|https?:\/\/|\bdata:|\bblob:/i.test(cspText.replace(/wasm-unsafe-eval/g, ''))) failures.push(`content_security_policy allows code from outside the package or eval: "${cspText}"`);
  return { failures, notes };
}

// Code that would run from outside the package, which Manifest V3 and the
// store's "remote code" answer ("None") forbid. Fetching data is fine; loading
// or evaluating code is not. The patterns read source text, not a parse: a
// match inside a string, a regular expression or a comment that does not
// start its line is reported too. If one ever fires on harmless text, reword
// that text rather than weakening the pattern.
const REMOTE_CODE = [
  { re: /<script\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\//i, why: 'a <script> from another host' },
  { re: /<link\b[^>]*\bhref\s*=\s*["']?(?:https?:)?\/\/[^>]*>/i, why: 'a stylesheet or preload from another host', test: (m) => /rel\s*=\s*["']?(stylesheet|preload|modulepreload)/i.test(m) },
  { re: /\b(?:import|export)\s*(?:[\w*{}\s,$]+from\s*)?["'](?:https?:)?\/\//, why: 'an import from another host' },
  { re: /\bimport\s*\(\s*["'`](?:https?:)?\/\//, why: 'a dynamic import from another host' },
  { re: /\bimport\s*\(\s*[^"'`\s)]/, why: 'a dynamic import of a computed address' },
  { re: /\bimportScripts\s*\(/, why: 'importScripts' },
  { re: /(?:(?<![\w.$])|\b(?:window|globalThis|self)\.)eval\s*\(/, why: 'eval' },
  // eval handed on as a value (`.then(eval)`, `(0, eval)(s)`, `window['eval']`).
  // The hyphen keeps a CSP's 'unsafe-eval' text out of it.
  { re: /(?:(?<![\w.$-])|\b(?:window|globalThis|self)\.)eval\b(?!\s*\()|\[\s*["'`]eval["'`]\s*\]/, why: 'eval used as a value' },
  { re: /(?<![\w.$])(?:new\s+)?Function\s*\(/, why: 'new Function' },
  { re: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/, why: 'a timer given a string of code' },
  { re: /\.(?:innerHTML|outerHTML)\s*=[^;\n]*<script/i, why: 'a script written into the page' },
  // The extension never builds a <script> element in code: one made by a
  // function injected into a page would load whatever its src names.
  { re: /\bcreateElement(?:NS)?\s*\([^)]*["'`]script["'`]\s*\)/i, why: 'a <script> element built in code' },
  { re: /\bnew\s+(?:Shared)?Worker\s*\(\s*["'`](?:https?:)?\/\//, why: 'a worker from another host' },
];

// A match on a comment line (// or a /* */ block's * line) is prose, not code.
function onCommentLine(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  return /^\s*(\/\/|\/?\*)/.test(text.slice(start, index));
}

export function findRemoteCode(files) {
  const failures = [];
  for (const [path, buf] of files) {
    if (!/\.(m?js|html?)$/i.test(path)) continue;
    const raw = buf.toString('utf8');
    const js = /\.m?js$/i.test(path);
    const text = js ? raw : raw.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
    for (const { re, why, test } of REMOTE_CODE) {
      const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      for (const m of text.matchAll(global)) {
        if (test && !test(m[0])) continue;
        if (js && onCommentLine(text, m.index)) continue;
        const line = text.slice(0, m.index).split('\n').length;
        failures.push(`${path}:${line}: ${why}`);
      }
    }
  }
  return failures;
}

// Every relative import and every <script src>/<link href> resolves to a file
// in the package, so the zip is not missing a module the extension loads.
export function findMissingReferences(files) {
  const failures = [];
  for (const [path, buf] of files) {
    const dir = posix.dirname(path);
    const text = buf.toString('utf8');
    const refs = [];
    if (/\.m?js$/i.test(path)) {
      for (const m of text.matchAll(/\b(?:import|export)\s+(?:[\w*{}\s,$]+?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/g)) if (!onCommentLine(text, m.index)) refs.push(m[1]);
      for (const m of text.matchAll(/\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) if (!onCommentLine(text, m.index)) refs.push(m[1]);
    } else if (/\.html?$/i.test(path)) {
      const html = text.replace(/<!--[\s\S]*?-->/g, '');
      for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) refs.push(m[1]);
      for (const m of html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) refs.push(m[1]);
      for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) refs.push(m[1]);
    } else continue;
    for (const ref of refs) {
      if (/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(ref)) continue;
      const target = ref.startsWith('/') ? ref.slice(1) : posix.normalize(posix.join(dir, ref));
      const clean = target.split(/[?#]/)[0];
      if (!files.has(clean)) failures.push(`${path} loads ${ref}, which is not in the package`);
    }
  }
  return failures;
}

export function findStrayFiles(files) {
  const failures = [];
  for (const path of files.keys()) {
    if (/\.map$/i.test(path)) failures.push(`${path}: a source map; the package ships none`);
    if (/(^|\/)\.(git|env)(\/|$)|(^|\/)\.env\b/.test(path)) failures.push(`${path}: not part of the extension`);
    if (/\.(zip|crx|pem)$/i.test(path)) failures.push(`${path}: a package or key inside the package`);
    if (/(^|\/)(test|tests|node_modules)\//.test(path)) failures.push(`${path}: tests or dependencies inside the package`);
  }
  return failures;
}

// The entry names of a zip, from its central directory, with each entry's
// bytes when `withData` (stored or deflated only, which is all pack.mjs writes).
export function readZip(buf, withData = false) {
  let end = -1;
  if (buf.length < 22) throw new Error('not a zip: too short');
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('not a zip: no end of central directory');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('a broken central directory');
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    const entry = { name };
    if (withData) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const body = buf.subarray(start, start + compressed);
      entry.data = method === 0 ? Buffer.from(body) : method === 8 ? inflateRawSync(body) : null;
    }
    entries.push(entry);
    p += 46 + nameLength + extra + comment;
  }
  return entries;
}

export function compareZip(entries, files) {
  const failures = [];
  const names = new Set(entries.map((e) => e.name));
  if (!names.has('manifest.json')) failures.push('the zip has no manifest.json at its top level');
  for (const name of names) if (!files.has(name)) failures.push(`the zip holds ${name}, which is not in extension/`);
  for (const name of files.keys()) if (!names.has(name)) failures.push(`the zip is missing ${name}`);
  for (const e of entries) {
    if (e.data === null) failures.push(`the zip stores ${e.name} with a compression this check cannot read: pack again with npm run pack`);
    else if (e.data && files.has(e.name) && !e.data.equals(files.get(e.name))) failures.push(`the zip's ${e.name} differs from extension/${e.name}: pack again`);
  }
  return failures;
}

// This version's zips among dist/'s file names: the store upload
// (<name>-extension-<version>.zip) and the pilot zip for testers
// (<name>-extension-<version>-pilot.zip).
export function distZips(names, version) {
  return {
    store: names.filter((n) => n.endsWith(`-extension-${version}.zip`)),
    pilot: names.filter((n) => n.endsWith(`-extension-${version}-pilot.zip`)),
  };
}

// A pilot zip against extension/'s files: every file but the account config
// as compareZip checks it, and the account config loaded as a module, which
// must give accounts off and be exactly what npm run pack -- --pilot makes of
// the committed file. [] when it is right.
export async function checkPilotZip(entries, files) {
  const others = new Map([...files].filter(([name]) => name !== PILOT_CONFIG_PATH));
  const failures = compareZip(entries.filter((e) => e.name !== PILOT_CONFIG_PATH), others);
  const config = entries.find((e) => e.name === PILOT_CONFIG_PATH);
  if (!config) return [...failures, `the zip is missing ${PILOT_CONFIG_PATH}`];
  if (!config.data) return [...failures, `the zip stores ${PILOT_CONFIG_PATH} with a compression this check cannot read: pack again with npm run pack -- --pilot`];
  const text = config.data.toString('utf8');
  for (const p of await accountsOffProblems(text)) failures.push(`its ${PILOT_CONFIG_PATH} does not turn accounts off: ${p}`);
  if (files.has(PILOT_CONFIG_PATH)) {
    let want = null;
    try {
      want = pilotAccountConfig(files.get(PILOT_CONFIG_PATH).toString('utf8'));
    } catch (e) {
      failures.push(e.message);
    }
    if (want !== null && text !== want) failures.push(`its ${PILOT_CONFIG_PATH} is not what npm run pack -- --pilot makes of extension/${PILOT_CONFIG_PATH}: pack it again with npm run pack -- --pilot`);
  }
  return failures;
}

// The text between "## <heading>" and the next "## ", without the heading.
export function section(md, heading) {
  const re = new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const m = re.exec(md);
  if (!m) return null;
  const rest = md.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

// [bracketed] placeholders: not a Markdown link, not a task-list box.
export function placeholders(text) {
  const out = [];
  for (const m of text.matchAll(/\[(?!\s?\]|x\])([^\]\n]{2,})\](?!\()/gi)) out.push(m[0]);
  return out;
}

// The support inbox the website names (supportEmail in site/config.js), or ''.
// That file is the one place the owner records the inbox, so an address
// there is the one he confirmed; whether it receives mail stays a box on the
// listing's "Before submitting" list, which no script can tick.
export function configuredSupportEmail(configText) {
  const m = String(configText || '').match(/^\s*supportEmail:\s*'([^']*)'/m);
  return m ? m[1].trim() : '';
}

// What stands between the listing and a submission. Returns { failures, conditions }.
// supportEmail: the inbox site/config.js names, accepted on the listing like a support@ address.
export function checkListing({ listing, privacy, manifest, legalLinks = '', legalStatus = null, supportEmail = '' }) {
  const failures = [];
  const conditions = [];
  const name = section(listing, 'Item name');
  if (name !== manifest.name) failures.push(`store/listing.md's Item name "${name}" is not the manifest name "${manifest.name}"`);
  const summary = section(listing, 'Summary');
  if (!summary || !summary.split('\n').map((l) => l.trim()).includes(manifest.description)) failures.push('store/listing.md\'s Summary does not hold the manifest description on a line of its own');
  const detailed = section(listing, 'Detailed description');
  if (!detailed) failures.push('store/listing.md has no Detailed description');
  else {
    if (detailed.length > LIMITS.detailedDescription) failures.push(`the detailed description is ${detailed.length} characters; the limit is ${LIMITS.detailedDescription}`);
    for (const brand of THIRD_PARTY_NAMES) {
      const n = (detailed.match(new RegExp(`\\b${brand}\\b`, 'g')) || []).length;
      if (n > MAX_NAME_REPEATS) failures.push(`the detailed description names ${brand} ${n} times; keep another company's name to ${MAX_NAME_REPEATS} or fewer (keyword spam)`);
    }
    if (/`/.test(detailed)) failures.push('the detailed description has Markdown code marks; the dashboard shows them as typed');
    for (const p of placeholders(detailed)) conditions.push(`the detailed description still says ${p}`);
  }
  const tests = section(listing, 'Test instructions');
  if (!tests) failures.push('store/listing.md has no Test instructions for the reviewer');
  else for (const p of placeholders(tests)) conditions.push(`the test instructions still say ${p}`);
  const support = section(listing, 'Support and homepage') || '';
  for (const p of placeholders(support)) conditions.push(`Support and homepage still says ${p}`);
  for (const addr of new Set(support.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [])) {
    if (!/^support@/i.test(addr) && addr.toLowerCase() !== String(supportEmail).toLowerCase()) conditions.push(`Support and homepage names ${addr}, not a support inbox: put the inbox site/config.js names (supportEmail) or a support@ address there`);
  }
  if (/\.example\b/.test(support)) conditions.push('Support and homepage still names .example addresses');
  if (/\.example\b/.test(legalLinks)) conditions.push('extension/src/legalLinks.js still points at .example addresses');
  if (legalStatus?.draft !== false) conditions.push('legal/legal-status.json says the legal pages are drafts (the attorney has not signed off)');
  for (const [file, text] of [['store/listing.md', listing], ['legal/chrome-web-store-privacy.md', privacy]]) {
    const pending = (text.match(/\[Pending attorney answer/g) || []).length;
    if (pending) conditions.push(`${file} has ${pending} "[Pending attorney answer" mark${pending === 1 ? '' : 's'}`);
  }
  if (/^DRAFT\b/m.test(privacy.split('\n')[0] || '')) conditions.push('legal/chrome-web-store-privacy.md is still marked DRAFT');
  return { failures, conditions };
}

// screenshots: [{ name, buf }]; promo: [{ file, buf|null }]
export function checkImages({ screenshots, promo }) {
  const failures = [];
  const conditions = [];
  if (!screenshots.length) conditions.push('no screenshots in store/screenshots/ yet (the owner takes them: store/screenshots.md)');
  if (screenshots.length > LIMITS.screenshots) failures.push(`${screenshots.length} screenshots; the store shows at most ${LIMITS.screenshots}`);
  for (const { name, buf } of screenshots) {
    const dims = imageSize(name, buf);
    if (!dims) failures.push(`store/screenshots/${name} is not a PNG or JPEG`);
    else if (!SCREENSHOT_SIZES.includes(`${dims.width}x${dims.height}`)) failures.push(`store/screenshots/${name} is ${dims.width} x ${dims.height}; the store takes 1280 x 800 or 640 x 400`);
  }
  for (const want of PROMO) {
    const got = promo.find((p) => p.file === want.file);
    if (!got?.buf) { if (want.required) failures.push(`store/images/${want.file} is missing; the small promo tile is required`); continue; }
    const dims = pngSize(got.buf);
    if (!dims || dims.width !== want.width || dims.height !== want.height) failures.push(`store/images/${want.file} is not a ${want.width} x ${want.height} PNG`);
  }
  return { failures, conditions };
}

// --- the command ---

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = relative(base, full).split(sep).join('/');
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else if (!SKIP.test(rel)) out.push(rel);
  }
  return out;
}

// zip: false leaves dist/ alone (the unit test runs on a tree that may hold a
// zip packed before the last edit).
export async function runChecks(root, { zip = true } = {}) {
  const read = (rel) => readFileSync(join(root, rel), 'utf8');
  const extDir = join(root, 'extension');
  const files = new Map(walk(extDir).map((rel) => [rel, readFileSync(join(extDir, rel))]));
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
  const failures = [];
  const conditions = [];
  const notes = [];

  const m = checkManifest(manifest, files);
  failures.push(...m.failures);
  notes.push(...m.notes);
  failures.push(...findRemoteCode(files), ...findMissingReferences(files), ...findStrayFiles(files));
  const total = [...files.values()].reduce((n, b) => n + b.length, 0);
  notes.push(`extension/: ${files.size} files, ${(total / 1024).toFixed(0)} KB`);

  const distDir = join(root, 'dist');
  const { store: zips, pilot: pilotZips } = distZips(zip && existsSync(distDir) ? readdirSync(distDir) : [], manifest.version);
  if (zip && !zips.length) conditions.push(`no dist/*-extension-${manifest.version}.zip yet: run npm run pack`);
  for (const z of zips) {
    const buf = readFileSync(join(distDir, z));
    if (buf.length > LIMITS.packageBytes) failures.push(`dist/${z} is over the store's 2 GB package limit`);
    try {
      const zf = compareZip(readZip(buf, true), files);
      failures.push(...zf.map((f) => `dist/${z}: ${f}`));
      if (!zf.length) notes.push(`dist/${z}: ${(buf.length / 1024).toFixed(0)} KB, the same files as extension/: the zip the store upload takes`);
    } catch (e) {
      failures.push(`dist/${z}: ${e.message}`);
    }
  }
  // The pilot zip is checked when it is there; none is not a finding.
  for (const z of pilotZips) {
    const buf = readFileSync(join(distDir, z));
    try {
      const pf = await checkPilotZip(readZip(buf, true), files);
      failures.push(...pf.map((f) => `dist/${z}: ${f}`));
      if (!pf.length) notes.push(`dist/${z}: ${(buf.length / 1024).toFixed(0)} KB, the same files as extension/ except ${PILOT_CONFIG_PATH}, left empty (no sign-in): for testers while the pilot runs signed out, never the store upload`);
    } catch (e) {
      failures.push(`dist/${z}: ${e.message}`);
    }
  }

  const legalStatusPath = join(root, 'legal/legal-status.json');
  const l = checkListing({
    listing: read('store/listing.md'),
    privacy: read('legal/chrome-web-store-privacy.md'),
    manifest,
    legalLinks: existsSync(join(root, 'extension/src/legalLinks.js')) ? read('extension/src/legalLinks.js') : '',
    legalStatus: existsSync(legalStatusPath) ? JSON.parse(read('legal/legal-status.json')) : null,
    supportEmail: existsSync(join(root, 'site/config.js')) ? configuredSupportEmail(read('site/config.js')) : '',
  });
  failures.push(...l.failures);
  conditions.push(...l.conditions);

  const shotsDir = join(root, 'store/screenshots');
  const screenshots = existsSync(shotsDir)
    ? readdirSync(shotsDir).filter((n) => /\.(png|jpe?g)$/i.test(n)).sort().map((name) => ({ name, buf: readFileSync(join(shotsDir, name)) }))
    : [];
  const promo = PROMO.map(({ file }) => {
    const p = join(root, 'store/images', file);
    return { file, buf: existsSync(p) ? readFileSync(p) : null };
  });
  const i = checkImages({ screenshots, promo });
  failures.push(...i.failures);
  conditions.push(...i.conditions);

  return { manifest, failures, conditions, notes };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const strict = process.argv.includes('--strict');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const { manifest, failures, conditions, notes } = await runChecks(root);
  console.log(`Chrome Web Store preflight: ${manifest.name} ${manifest.version}`);
  for (const n of notes) console.log(`  ${n}`);
  if (failures.length) {
    console.log(`\nWrong now (${failures.length}):`);
    for (const f of failures) console.log(`  x ${f}`);
  } else console.log('\nNothing wrong with the package or the listing text.');
  if (conditions.length) {
    console.log(`\nNot ready to submit yet (${conditions.length}):`);
    for (const c of conditions) console.log(`  - ${c}`);
  } else console.log('\nNothing left before a submission.');
  process.exitCode = failures.length || (strict && conditions.length) ? 1 : 0;
}
