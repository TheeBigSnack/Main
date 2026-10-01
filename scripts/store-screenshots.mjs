// Fits the owner's own screen captures to the Chrome Web Store's screenshot
// size (store/screenshots.md). Each image in store/screenshots/raw/, in name
// order, becomes store/screenshots/<n>.png at exactly 1280 x 800: scaled down
// (never up past its own size) to fit, centred on white, nothing cropped, so
// nothing the owner covered can shift back into view and nothing is cut off.
// At most five; the store shows no more.
//
// Run:  node scripts/store-screenshots.mjs   (npm run store-screenshots)
// Needs the repo's Playwright and a Chromium, like scripts/store-images.mjs.
// Both folders are ignored by git: the captures come from a real dealership
// website and a real listing, so they stay on the owner's computer and go
// only to the dashboard. Cover personal details before running this; the
// script does not look for them.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, imageSize } from './store-check.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = join(root, 'store/screenshots');
const rawDir = join(dir, 'raw');
const WIDTH = 1280;
const HEIGHT = 800;

if (!existsSync(rawDir)) {
  mkdirSync(rawDir, { recursive: true });
  console.log(`Put the captures in ${relative(root, rawDir)}/ (PNG or JPEG, named so they sort in order: 1-ready.png, 2-review.png, ...), then run this again.`);
  process.exit(0);
}
const raws = readdirSync(rawDir).filter((n) => /\.(png|jpe?g)$/i.test(n)).sort();
if (!raws.length) { console.log(`No PNG or JPEG in ${relative(root, rawDir)}/ yet.`); process.exit(0); }
if (raws.length > LIMITS.screenshots) { console.error(`${raws.length} captures; the store shows at most ${LIMITS.screenshots}. Keep the five that tell the story.`); process.exit(1); }

const { chromium } = await import('playwright');
const DEFAULT_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath = process.env.LOTSYNC_CHROME || (existsSync(DEFAULT_CHROME) ? DEFAULT_CHROME : undefined);
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const drawn = [];
  for (const [i, name] of raws.entries()) {
    const buf = readFileSync(join(rawDir, name));
    const dims = imageSize(name, buf);
    if (!dims) throw new Error(`${name}: not a PNG or JPEG the script can read`);
    const scale = Math.min(1, WIDTH / dims.width, HEIGHT / dims.height);
    const w = Math.round(dims.width * scale);
    const h = Math.round(dims.height * scale);
    const type = /\.png$/i.test(name) ? 'png' : 'jpeg';
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><style>html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;background:#fff;overflow:hidden}img{position:absolute;left:${Math.floor((WIDTH - w) / 2)}px;top:${Math.floor((HEIGHT - h) / 2)}px;width:${w}px;height:${h}px}</style><img alt="">`);
    await page.locator('img').evaluate((img, src) => { img.src = src; return img.decode(); }, `data:image/${type};base64,${buf.toString('base64')}`);
    const bytes = await page.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
    await page.close();
    const got = imageSize('x.png', bytes);
    if (got?.width !== WIDTH || got?.height !== HEIGHT) throw new Error(`${name}: drew ${got?.width} x ${got?.height}`);
    drawn.push({ out: join(dir, `${i + 1}.png`), bytes, line: `from ${name} (${dims.width} x ${dims.height}${scale < 1 ? `, scaled to ${w} x ${h}` : ''})` });
  }
  // Every capture drew: only now replace the old set.
  for (const old of readdirSync(dir).filter((n) => /^\d+\.png$/.test(n))) rmSync(join(dir, old));
  for (const { out, bytes, line } of drawn) {
    writeFileSync(out, bytes);
    console.log(`${relative(root, out)}: ${line}`);
  }
} finally {
  await browser.close();
}
console.log('Check each one by eye for anything personal, then npm run store-check.');
