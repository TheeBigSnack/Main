// Draws the share image behind each page's og:image (site/social/<slug>.png,
// 1200 x 630) from site-src/social/template.html in headless Chromium: the
// mark, the name, the page's social heading (the site map's social.heading,
// scripts/site-pages.mjs) and the line "You click Publish. Lot Current never
// does.", in the site's own colours, and nothing else: no other claim, no
// number, no screenshot, no other company's name or mark.
//
// It also writes site/social/images.json: for every page path, the image's
// path, width, height and the alt sentence the page carries as og:image:alt.
// The sentence is altFor(heading) here and socialAlt(page) in site-pages.mjs;
// the two are compared on every run, so they cannot drift apart.
//
// Run:  npm run social-images
// Needs the repo's Playwright (npm ci) and a Chromium: LOTSYNC_CHROME=<path>
// to a Chrome/Chromium binary, else the one under /opt/pw-browsers, else the
// one Playwright installed (npx playwright install chromium).
//
// Before drawing, the template's text is checked to be the name, a heading
// and the line and nothing else. Each image is checked after drawing: the
// mark loaded, the text within MARGIN of every edge, the name on one line,
// the heading on at most two, the line on one, the PNG header's 1200 x 630,
// the file at most SIZE_LIMIT. Nothing is written until every image passes.
// test/siteImages.test.js checks the files and the template without a
// browser. Playwright and the site map are imported inside main(), so
// importing this file's helpers costs nothing.

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const TEMPLATE = 'site-src/social/template.html';
export const DIR = 'site/social';
export const IMAGES_JSON = 'site/social/images.json';
export const SIZE = Object.freeze({ width: 1200, height: 630 });
export const SIZE_LIMIT = 300 * 1024;
export const MARGIN = 40;
export const LINE = 'You click Publish. Lot Current never does.';

// Width and height from the PNG's IHDR chunk, so a wrong size cannot ship quietly.
export function pngSize(buf) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(signature) || buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// What the template says: the body's text, tags gone, spaces collapsed.
export function templateText(html) {
  const body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [, ''])[1];
  return body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// The heading the template rests on (the home page's), between the h2 tags.
export function restingHeading(html) {
  const m = html.match(/<h2 id="heading">([^<]*)<\/h2>/);
  if (!m) throw new Error(`${TEMPLATE} has no <h2 id="heading">`);
  return m[1].trim();
}

// The og:image:alt sentence for a heading: what the image shows, in words.
export const altFor = (heading) => `Lot Current's green check mark with the words "${heading}" and "${LINE}"`;

// A page's social heading as the image may show it: a plain sentence with no
// number and no other company's name, short enough for two lines.
export function checkHeading(page) {
  const heading = page && page.social && page.social.heading;
  const name = page && page.slug ? page.slug : 'a page';
  if (typeof heading !== 'string' || !heading.trim()) throw new Error(`${name}: no social heading`);
  if (/\d/.test(heading)) throw new Error(`${name}: the heading "${heading}" has a number in it`);
  if (/facebook|marketplace|\bmeta\b|instagram|whatsapp/i.test(heading)) throw new Error(`${name}: the heading "${heading}" names another company or its product`);
  if (heading.length > 70) throw new Error(`${name}: the heading "${heading}" is ${heading.length} characters, at most 70`);
  return heading;
}

// The pages the images are drawn for: those with a social heading, in map order.
export const socialPages = (pages) => pages.filter((p) => p.social);

// site/social/images.json: by page path, the image's path, width, height and alt.
export function imagesJson(pages) {
  const out = {};
  for (const page of socialPages(pages)) {
    out[page.path] = { path: `/${DIR.replace(/^site\//, '')}/${page.slug}.png`, width: SIZE.width, height: SIZE.height, alt: altFor(page.social.heading) };
  }
  return JSON.stringify(out, null, 2) + '\n';
}

const CHROME_CANDIDATES = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'];
export const chromePath = () => process.env.LOTSYNC_CHROME || CHROME_CANDIDATES.find((p) => existsSync(p));

// The site map, from scripts/site-pages.mjs unless the caller brings one.
async function loadMap({ pages, socialAlt }) {
  if (pages) return { pages, socialAlt };
  let mod;
  try {
    mod = await import('./site-pages.mjs');
  } catch (e) {
    throw new Error(`scripts/site-pages.mjs could not be loaded (${e.message}); the site map's social headings are needed`);
  }
  if (!Array.isArray(mod.PAGES)) throw new Error('scripts/site-pages.mjs exports no PAGES array');
  return { pages: mod.PAGES, socialAlt: typeof mod.socialAlt === 'function' ? mod.socialAlt : undefined };
}

// Runs inside the template page after the heading is set: the boxes of the
// three pieces of text, how many lines each takes, and the text as shown.
function measure() {
  const rowsOf = (el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
  const parts = [document.querySelector('.brand'), document.getElementById('heading'), document.querySelector('main > p')];
  const boxes = parts.map((el) => el.getBoundingClientRect());
  return {
    box: { left: Math.min(...boxes.map((b) => b.left)), top: Math.min(...boxes.map((b) => b.top)), right: Math.max(...boxes.map((b) => b.right)), bottom: Math.max(...boxes.map((b) => b.bottom)) },
    name: rowsOf(document.querySelector('h1')),
    heading: rowsOf(document.getElementById('heading')),
    line: rowsOf(document.querySelector('main > p')),
    scroll: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    text: document.body.innerText.replace(/\s+/g, ' ').trim(),
  };
}

export async function main({ pages, socialAlt, log = (s) => console.log(s) } = {}) {
  const map = await loadMap({ pages, socialAlt });
  const html = readFileSync(join(root, TEMPLATE), 'utf8');
  const resting = restingHeading(html);
  const text = templateText(html);
  if (text !== `Lot Current ${resting} ${LINE}`) throw new Error(`${TEMPLATE} says "${text}"; it must say the name, the heading and the line, "Lot Current ${resting} ${LINE}", and nothing else`);
  checkHeading({ slug: TEMPLATE, social: { heading: resting } });
  const targets = socialPages(map.pages);
  if (!targets.length) throw new Error('no page of the site map has a social heading');
  const slugs = new Set();
  for (const page of targets) {
    if (typeof page.slug !== 'string' || !/^[a-z0-9-]+$/.test(page.slug)) throw new Error(`a page's slug is not a file name: ${JSON.stringify(page.slug)}`);
    if (slugs.has(page.slug)) throw new Error(`two pages share the slug ${page.slug}`);
    slugs.add(page.slug);
    checkHeading(page);
    if (map.socialAlt && map.socialAlt(page) !== altFor(page.social.heading)) {
      throw new Error(`${page.slug}: site-pages.mjs's socialAlt says "${map.socialAlt(page)}" and this script writes "${altFor(page.social.heading)}"; the two must agree`);
    }
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const drawn = [];
  try {
    for (const page of targets) {
      const { width, height } = SIZE;
      const name = `${DIR}/${page.slug}.png`;
      const tab = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      await tab.goto(pathToFileURL(join(root, TEMPLATE)).href);
      await tab.evaluate(() => document.fonts.ready);
      const mark = await tab.evaluate(async () => {
        const img = document.querySelector('.plate img');
        await img.decode().catch(() => {});
        return img.naturalWidth;
      });
      if (mark !== 64) throw new Error(`${name}: the mark did not load (site/favicon.svg)`);
      await tab.evaluate((heading) => { document.getElementById('heading').textContent = heading; }, page.social.heading);
      const layout = await tab.evaluate(measure);
      const { box } = layout;
      if (layout.text !== `Lot Current ${page.social.heading} ${LINE}`) throw new Error(`${name}: the page shows "${layout.text}"`);
      if (box.left < MARGIN || box.top < MARGIN || box.right > width - MARGIN || box.bottom > height - MARGIN) throw new Error(`${name}: the text runs within ${MARGIN}px of the edge or past it`);
      if (layout.scroll.width > width || layout.scroll.height > height) throw new Error(`${name}: the page overflows ${width} x ${height}`);
      if (layout.name !== 1) throw new Error(`${name}: the name wraps onto ${layout.name} lines`);
      if (layout.heading < 1 || layout.heading > 2) throw new Error(`${name}: the heading takes ${layout.heading} lines, at most 2`);
      if (layout.line !== 1) throw new Error(`${name}: the line wraps onto ${layout.line} lines`);
      const buf = await tab.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } });
      await tab.close();
      const size = pngSize(buf);
      if (size.width !== width || size.height !== height) throw new Error(`${name} is ${size.width} x ${size.height}, not ${width} x ${height}`);
      if (buf.length > SIZE_LIMIT) throw new Error(`${name} is ${(buf.length / 1024).toFixed(0)} KB, over ${SIZE_LIMIT / 1024} KB`);
      drawn.push({ name, buf });
    }
  } finally {
    await browser.close();
  }

  mkdirSync(join(root, DIR), { recursive: true });
  for (const { name, buf } of drawn) {
    writeFileSync(join(root, name), buf);
    log(`${name}: ${SIZE.width} x ${SIZE.height}, ${(buf.length / 1024).toFixed(0)} KB`);
  }
  writeFileSync(join(root, IMAGES_JSON), imagesJson(targets));
  log(`${IMAGES_JSON}: ${targets.length} page${targets.length === 1 ? '' : 's'}`);
  // a PNG no page of the map owns is left over from a page that was renamed or removed
  const keep = new Set(drawn.map((d) => d.name.slice(DIR.length + 1)));
  for (const file of readdirSync(join(root, DIR))) {
    if (file.endsWith('.png') && !keep.has(file)) {
      unlinkSync(join(root, DIR, file));
      log(`removed ${DIR}/${file}: no page of the site map owns it`);
    }
  }
  return drawn.map((d) => d.name);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
