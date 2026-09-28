// Packs the extension into dist/lot-sync-extension-<version>.zip: exactly the files under
// extension/, nothing else, with the version from manifest.json in the name.
// Plain Node (22+, the repo's engine), no dependencies: a small zip writer (deflate via zlib).
//
// Run: npm run pack        -> dist/lot-sync-extension-0.4.0.zip
// The same zip is what a tester unzips (README, "Install") and what the
// Chrome Web Store upload takes (Milestone 5).

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'extension');
const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.version !== manifest.version) {
  console.error(`package.json says ${pkg.version} but extension/manifest.json says ${manifest.version}; make them equal first.`);
  process.exit(1);
}
const out = join(root, 'dist', `lot-sync-extension-${manifest.version}.zip`);

// Files a packed extension must not carry (editor and OS leftovers).
const SKIP = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|.*\.swp|.*~)$/;

function walk(dir, base = dir) {
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = relative(base, full).split(sep).join('/');
    if (statSync(full).isDirectory()) files.push(...walk(full, base));
    else if (!SKIP.test(rel)) files.push(rel);
  }
  return files;
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A fixed DOS date/time so the same files always give the same bytes (2026-01-01 00:00).
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

export function zip(entries) {
  // entries: [{ name, data: Buffer }]
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const store = deflated.length >= data.length; // no gain: store it as is
    const body = store ? data : deflated;
    const method = store ? 0 : 8;
    const crc = crc32(data);
    const head = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(DOS_TIME), u16(DOS_DATE), u32(crc), u32(body.length), u32(data.length), u16(nameBuf.length), u16(0), nameBuf]);
    locals.push(head, body);
    centrals.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(method), u16(DOS_TIME), u16(DOS_DATE), u32(crc), u32(body.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf]));
    offset += head.length + body.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(central.length), u32(offset), u16(0)]);
  return Buffer.concat([...locals, central, end]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = walk(src);
  const entries = files.map((rel) => ({ name: rel, data: readFileSync(join(src, rel)) }));
  mkdirSync(join(root, 'dist'), { recursive: true });
  const bytes = zip(entries);
  writeFileSync(out, bytes);
  console.log(`${relative(root, out)}: ${files.length} files, ${(bytes.length / 1024).toFixed(0)} KB (Lot Sync ${manifest.version})`);
}
