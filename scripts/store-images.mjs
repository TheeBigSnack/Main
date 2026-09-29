// Draws the Chrome Web Store promo images (store/listing.md, Promo tile) from
// store/images/tile.html in headless Chromium: the small tile at 440 x 280 and
// the optional marquee at 1400 x 560. The page is the extension's own icon,
// the name and the listing's one line on the product's green, nothing else:
// no other claim, no number, no screenshot, and nothing of Meta's
// (legal/trademark-note.md). The owner may replace the files with their own
// under the same names and sizes.
//
// Run:  node scripts/store-images.mjs     -> store/images/promo-*.png
// Needs the repo's Playwright (npm ci) and a Chromium: LOTSYNC_CHROME=<path>
// to a Chrome/Chromium binary, else the one Playwright installed
// (npx playwright install chromium).
//
// Before drawing, the page's text is checked against the line the listing
// quotes, so the two cannot drift apart. Each image is checked after drawing:
// the PNG header's width and height, the file under 1 MB, and the text inside
// the image with a margin and not wrapped (the fonts are the machine's own,
// so another machine draws slightly different letters). Each file is
// written only when its checks pass. test/storeImages.test.js checks the
// files, the page and the listing without a browser.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = join(root, 'store/images');
const tile = join(dir, 'tile.html');
const listing = join(root, 'store/listing.md');

// rows: how many lines the listing's line may take at that size
export const IMAGES = Object.freeze([
  Object.freeze({ name: 'promo-small-440x280.png', width: 440, height: 280, rows: 2 }),
  Object.freeze({ name: 'promo-marquee-1400x560.png', width: 1400, height: 560, rows: 1 }),
]);
export const SIZE_LIMIT = 1024 * 1024;
const MARGIN = 16;

// Width and height from the PNG's IHDR chunk, so a wrong size cannot ship quietly.
export function pngSize(buf) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(signature) || buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// The one line the listing's Promo tile section quotes.
export function promoLine(markdown) {
  const start = markdown.indexOf('## Promo tile');
  if (start < 0) throw new Error('store/listing.md has no "## Promo tile" section');
  const end = markdown.indexOf('\n## ', start + 1);
  const section = markdown.slice(start, end > 0 ? end : undefined);
  const m = section.match(/the one line "([^"]+)"/);
  if (!m) throw new Error('the Promo tile section no longer quotes the one line');
  return m[1];
}

// What the tile says: the body's text, tags gone, spaces collapsed.
export function tileText(html) {
  const body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [, ''])[1];
  return body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

async function main() {
  const line = promoLine(readFileSync(listing, 'utf8'));
  const text = tileText(readFileSync(tile, 'utf8'));
  if (text !== `Lot Sync ${line}`) throw new Error(`store/images/tile.html says "${text}"; it must say the name and the listing's line, "Lot Sync ${line}", and nothing else`);

  const { chromium } = await import('playwright');
  const DEFAULT_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const executablePath = process.env.LOTSYNC_CHROME || (existsSync(DEFAULT_CHROME) ? DEFAULT_CHROME : undefined);
  mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    for (const image of IMAGES) {
      const { name, width, height, rows } = image;
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      await page.goto(pathToFileURL(tile).href);
      await page.evaluate(() => document.fonts.ready);
      const icon = await page.evaluate(async () => {
        const img = document.querySelector('.plate img');
        await img.decode().catch(() => {});
        return img.naturalWidth;
      });
      if (icon !== 128) throw new Error(`${name}: the icon did not load (extension/icons/icon128.png)`);
      const layout = await page.evaluate(() => {
        const rowsOf = (el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
        const box = document.querySelector('main').getBoundingClientRect();
        return { box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom }, name: rowsOf(document.querySelector('h1')), line: rowsOf(document.querySelector('p')) };
      });
      const { box } = layout;
      if (box.left < MARGIN || box.top < MARGIN || box.right > width - MARGIN || box.bottom > height - MARGIN) throw new Error(`${name}: the text runs within ${MARGIN}px of the edge or past it`);
      if (layout.name !== 1) throw new Error(`${name}: the name wraps onto ${layout.name} lines`);
      if (layout.line > rows) throw new Error(`${name}: the line takes ${layout.line} lines, at most ${rows}`);

      const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } });
      await page.close();
      const size = pngSize(buf);
      if (size.width !== width || size.height !== height) throw new Error(`${name} is ${size.width} x ${size.height}, not ${width} x ${height}`);
      if (buf.length > SIZE_LIMIT) throw new Error(`${name} is ${(buf.length / 1024).toFixed(0)} KB, over ${SIZE_LIMIT / 1024} KB`);
      const file = join(dir, name);
      writeFileSync(file, buf);
      console.log(`${relative(root, file)}: ${size.width} x ${size.height}, ${(buf.length / 1024).toFixed(0)} KB`);
    }
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
