// Draws the website's favicons from site/favicon.svg (the extension's mark: a
// #14532d rounded square with the white check) in headless Chromium:
//
//   site/favicon-32.png        32 x 32 with transparent corners, for browser tabs
//   site/apple-touch-icon.png  180 x 180 on the mark's own green, no transparent
//                              corners: iOS fills transparency with black and
//                              rounds the square itself
//   site/favicon.ico           the 16 x 16 and 32 x 32 renderings as PNG entries
//                              in an ICO container written here (icoFromPngs)
//
// Run:  npm run favicons
// Needs the repo's Playwright (npm ci) and a Chromium: LOTSYNC_CHROME=<path>
// to a Chrome/Chromium binary, else the one under /opt/pw-browsers, else the
// one Playwright installed (npx playwright install chromium).
//
// Every rendering is checked before anything is written: the PNG header's
// width and height, the pixels (a transparent corner where the corners must
// be transparent, the green at the centre, the white of the check), and the
// ICO parsed back to its entries. The files are written only when every check
// passes. test/siteImages.test.js checks the committed files without a browser.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
export const SOURCE = 'site/favicon.svg';
export const GREEN = '#14532d';

// The sizes rendered from the SVG, and where each one goes.
export const SIZES = Object.freeze([16, 32, 180]);
export const FILES = Object.freeze([
  Object.freeze({ file: 'site/favicon-32.png', sizes: Object.freeze([32]), transparent: true }),
  Object.freeze({ file: 'site/apple-touch-icon.png', sizes: Object.freeze([180]), transparent: false }),
  Object.freeze({ file: 'site/favicon.ico', sizes: Object.freeze([16, 32]), transparent: true }),
]);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Width and height from the PNG's IHDR chunk, so a wrong size cannot ship quietly.
export function pngSize(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE) || buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// The PNG's pixels, decoded here (zlib is Node's own): 8-bit greyscale, RGB,
// greyscale+alpha and RGBA, not interlaced, which is what Chromium writes.
// Answers { width, height, pixel(x, y) -> [r, g, b, a] }.
export function pngPixels(buf) {
  const { width, height } = pngSize(buf);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (bitDepth !== 8 || !channels || interlace !== 0) throw new Error(`unsupported PNG: bit depth ${bitDepth}, colour type ${colorType}, interlace ${interlace}`);
  const idat = [];
  for (let at = 8; at + 8 <= buf.length;) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    if (type === 'IDAT') idat.push(buf.subarray(at + 8, at + 8 + length));
    if (type === 'IEND') break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const line = out.subarray(y * stride, (y + 1) * stride);
    const above = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = above ? above[i] : 0;
      const c = above && i >= channels ? above[i - channels] : 0;
      let predicted;
      if (filter === 0) predicted = 0;
      else if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      line[i] = (row[i] + predicted) & 0xff;
    }
  }
  const pixel = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) throw new Error(`pixel (${x}, ${y}) is outside ${width} x ${height}`);
    const i = y * stride + x * channels;
    if (channels === 1) return [out[i], out[i], out[i], 255];
    if (channels === 2) return [out[i], out[i], out[i], out[i + 1]];
    if (channels === 3) return [out[i], out[i + 1], out[i + 2], 255];
    return [out[i], out[i + 1], out[i + 2], out[i + 3]];
  };
  return { width, height, channels, pixel };
}

// An ICO holding PNG images (what every current browser reads): ICONDIR, one
// ICONDIRENTRY per image, then the PNG bytes. entries: [{ size, png }].
export function icoFromPngs(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 255) throw new Error('an ICO holds 1 to 255 images');
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach(({ size, png }, i) => {
    const { width, height } = pngSize(png);
    if (width !== size || height !== size) throw new Error(`entry ${i} is ${width} x ${height}, not ${size} x ${size}`);
    if (size < 1 || size > 256) throw new Error(`entry ${i}: an ICO image is 1 to 256 px, not ${size}`);
    const at = i * 16;
    dir[at] = size === 256 ? 0 : size; // width, 0 meaning 256
    dir[at + 1] = size === 256 ? 0 : size; // height
    dir[at + 2] = 0; // colour count: none, not a palette
    dir[at + 3] = 0; // reserved
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(png.length, at + 8); // bytes in resource
    dir.writeUInt32LE(offset, at + 12); // offset of the image
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// The entries of an ICO written by icoFromPngs (or any PNG-in-ICO):
// [{ width, height, bitCount, png }]. Throws on anything that is not that.
export function parseIco(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('not an ICO');
  const count = buf.readUInt16LE(4);
  if (!count || buf.length < 6 + 16 * count) throw new Error('not an ICO: the directory is cut short');
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    const width = buf[at] || 256;
    const height = buf[at + 1] || 256;
    const bitCount = buf.readUInt16LE(at + 6);
    const bytes = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    if (offset + bytes > buf.length) throw new Error(`entry ${i} runs past the end of the file`);
    const png = buf.subarray(offset, offset + bytes);
    let size;
    try {
      size = pngSize(png);
    } catch {
      throw new Error(`entry ${i} is not a PNG`);
    }
    if (size.width !== width || size.height !== height) throw new Error(`entry ${i} says ${width} x ${height} but holds a ${size.width} x ${size.height} PNG`);
    entries.push({ width, height, bitCount, png });
  }
  return entries;
}

// Where the mark's colours are, as fractions of the square: the centre is
// green, the check's lower corner is white, the top-left pixel is outside
// the rounded corner. At 16 px the corner pixel touches the arc, so the
// antialiasing leaves it a trace of alpha (about 1 of 255): transparent means
// at most FRINGE.
const near = ([r, g, b], [R, G, B], tolerance = 12) => Math.abs(r - R) <= tolerance && Math.abs(g - G) <= tolerance && Math.abs(b - B) <= tolerance;
const GREEN_RGB = [0x14, 0x53, 0x2d];
const FRINGE = 16;

// Throws unless the PNG shows the mark at that size, with transparent corners
// when asked for.
export function checkMark(png, size, transparent) {
  const { width, height, pixel } = pngPixels(png);
  if (width !== size || height !== size) throw new Error(`${width} x ${height}, not ${size} x ${size}`);
  const corner = pixel(0, 0);
  if (transparent && corner[3] > FRINGE) throw new Error(`the top-left corner is not transparent (alpha ${corner[3]})`);
  if (!transparent && !(corner[3] === 255 && near(corner, GREEN_RGB))) throw new Error('the top-left corner is not the mark\'s green');
  const centre = pixel(Math.round(size / 2), Math.round(size * 0.2));
  if (!(centre[3] === 255 && near(centre, GREEN_RGB))) throw new Error('the square is not the mark\'s green');
  const check = pixel(Math.round((size * 27.5) / 64), Math.round((size * 44.5) / 64));
  if (!(check[3] === 255 && check[0] > 180 && check[1] > 180 && check[2] > 180)) throw new Error('the white check is not there');
}

const CHROME_CANDIDATES = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'];
export const chromePath = () => process.env.LOTSYNC_CHROME || CHROME_CANDIDATES.find((p) => existsSync(p));

// Renders the SVG at each size: transparent around the rounded square, or on
// the mark's own green so the corners are filled. Answers Map<size, png>.
export async function renderSizes(browser, svg, sizes, transparentFor) {
  const out = new Map();
  for (const size of sizes) {
    const transparent = transparentFor(size);
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>html, body { margin: 0; background: ${transparent ? 'transparent' : GREEN}; } svg { display: block; width: ${size}px; height: ${size}px; }</style></head><body>${svg}</body></html>`);
    const png = await page.screenshot({ type: 'png', omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    out.set(size, png);
  }
  return out;
}

async function main() {
  const svg = readFileSync(join(root, SOURCE), 'utf8');
  if (!svg.startsWith('<svg')) throw new Error(`${SOURCE} does not start with <svg`);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  let rendered;
  try {
    // the touch icon alone is opaque: every size it is not rendered for is transparent
    const opaque = new Set(FILES.filter((f) => !f.transparent).flatMap((f) => f.sizes));
    rendered = await renderSizes(browser, svg, SIZES, (size) => !opaque.has(size));
  } finally {
    await browser.close();
  }
  const outputs = [];
  for (const { file, sizes, transparent } of FILES) {
    for (const size of sizes) checkMark(rendered.get(size), size, transparent);
    const buf = file.endsWith('.ico') ? icoFromPngs(sizes.map((size) => ({ size, png: rendered.get(size) }))) : rendered.get(sizes[0]);
    if (file.endsWith('.ico')) {
      const back = parseIco(buf);
      if (back.length !== sizes.length || back.some((e, i) => e.width !== sizes[i] || !e.png.equals(rendered.get(sizes[i])))) throw new Error(`${file} does not parse back to its ${sizes.join(' and ')} px entries`);
    }
    outputs.push({ file, buf, sizes });
  }
  for (const { file, buf, sizes } of outputs) {
    writeFileSync(join(root, file), buf);
    console.log(`${file}: ${sizes.map((s) => `${s} x ${s}`).join(', ')}, ${(buf.length / 1024).toFixed(1)} KB`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
