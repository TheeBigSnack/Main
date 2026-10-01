// Draws extension/icons/icon128.png, the icon the Chrome Web Store and the
// install dialog show, from the mark in site/favicon.svg, the way the store's
// image guidance asks: the artwork 96 x 96 in the middle of a 128 x 128 PNG
// with 16 transparent pixels on every side. The toolbar sizes (16, 32, 48)
// stay edge to edge; at those sizes the guidance asks for no padding.
//
// Run:  node scripts/extension-icon.mjs   (npm run extension-icon)
// Needs the repo's Playwright and a Chromium, like scripts/store-images.mjs:
// LOTSYNC_CHROME=<path>, else the preinstalled one, else Playwright's own.
// The file is written only when the drawn artwork's edges are exactly where
// they should be; scripts/store-check.mjs checks the padding on every run.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pngSize } from './store-check.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'extension/icons/icon128.png');
const svg = readFileSync(join(root, 'site/favicon.svg'), 'utf8');
export const SIZE = 128;
export const ART = 96;
const PAD = (SIZE - ART) / 2;

const { chromium } = await import('playwright');
const DEFAULT_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath = process.env.LOTSYNC_CHROME || (existsSync(DEFAULT_CHROME) ? DEFAULT_CHROME : undefined);
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}img{position:absolute;left:${PAD}px;top:${PAD}px;width:${ART}px;height:${ART}px}</style><img src="${src}" alt="">`);
  await page.locator('img').evaluate((img) => img.decode());
  const bytes = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: SIZE, height: SIZE } });
  const dims = pngSize(bytes);
  if (!dims || dims.width !== SIZE || dims.height !== SIZE) throw new Error(`drew ${dims?.width} x ${dims?.height}, not ${SIZE} x ${SIZE}`);
  // the artwork's opaque edges, read back from the drawn image
  const box = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const a = ctx.getImageData(0, 0, c.width, c.height).data;
    let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (a[(y * c.width + x) * 4 + 3] > 8) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    return { minX, minY, maxX, maxY };
  }, bytes.toString('base64'));
  const want = { minX: PAD, minY: PAD, maxX: PAD + ART - 1, maxY: PAD + ART - 1 };
  for (const k of Object.keys(want)) {
    if (Math.abs(box[k] - want[k]) > 1) throw new Error(`the artwork's ${k} is ${box[k]}, expected ${want[k]}: not written`);
  }
  writeFileSync(out, bytes);
  console.log(`${relative(root, out)}: ${SIZE} x ${SIZE}, artwork ${box.maxX - box.minX + 1} x ${box.maxY - box.minY + 1} at ${box.minX},${box.minY}, ${bytes.length} bytes`);
} finally {
  await browser.close();
}
