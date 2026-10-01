// The website's images, checked without a browser: the favicon set drawn by
// scripts/favicons.mjs from site/favicon.svg (the sizes, the ICO's two PNG
// entries, transparent corners where they belong and none on the touch icon,
// the mark actually in the pixels), the share images drawn by
// scripts/social-images.mjs from site-src/social/template.html (one 1200 x 630
// PNG per page of the site map, at most 300 KB, their alt sentences in
// site/social/images.json), the template itself (the name, a heading and the
// one line, the site's colours, nothing loaded from elsewhere, no other
// company's name), and the two scripts' pure helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { FILES, SIZES, checkMark, icoFromPngs, parseIco, pngPixels, pngSize } from '../scripts/favicons.mjs';
import { DIR, IMAGES_JSON, LINE, MARGIN, SIZE, SIZE_LIMIT, TEMPLATE, altFor, checkHeading, imagesJson, pngSize as socialPngSize, restingHeading, socialPages, templateText } from '../scripts/social-images.mjs';

const path = (rel) => new URL(`../${rel}`, import.meta.url);
const read = (rel) => readFileSync(path(rel), 'utf8');
const css = read('site/site.css');
const svg = read('site/favicon.svg');
const template = read(TEMPLATE);

const GREEN = '#14532d';
const WHITE = '#ffffff';
const SOFT = '#e8f5ec';
// the pages with a share image: scripts/site-pages.mjs's map (test/sitePages.test.js checks the two agree)
const SOCIAL = [
  { slug: 'home', path: '/' },
  { slug: 'how-it-works', path: '/how-it-works/' },
  { slug: 'pricing', path: '/pricing/' },
  { slug: 'faq', path: '/faq/' },
  { slug: 'for-managers', path: '/for-managers/' },
  { slug: 'support', path: '/support/' },
  { slug: 'legal', path: '/legal/' },
  { slug: 'legal-terms', path: '/legal/terms/' },
  { slug: 'legal-privacy', path: '/legal/privacy/' },
  { slug: 'legal-posting-rules', path: '/legal/posting-rules/' },
];
// what no file under site/ or site-src/ may say (test/sitePages.test.js scans them all; these are the images' own)
const FORBIDDEN = /\bVite\b|\bReact\b|lorem|TODO|placeholder|example\.com|\.example\b|yourdomain|Welcome to/i;
const PILOT = /Waynesburg|Ron Lewis|Cranberry|Pleasant Hills|15370|\$\s?490\b|\bRoger\b|ronlewis/i;
const OTHERS = /Facebook|Marketplace|\bMeta\b|Instagram|WhatsApp/;

const hexColours = (s) => [...new Set([...s.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0].toLowerCase()))];
const near = ([r, g, b], [R, G, B], t = 12) => Math.abs(r - R) <= t && Math.abs(g - G) <= t && Math.abs(b - B) <= t;
const GREEN_RGB = [0x14, 0x53, 0x2d];

// A PNG that is only a signature and an IHDR: enough for the size readers and the ICO container.
function fakePng(width, height) {
  const buf = Buffer.alloc(8 + 4 + 4 + 13 + 4);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; // bit depth
  buf[25] = 6; // RGBA
  return buf;
}

test('favicon.svg is the mark and nothing else: a green rounded square with a white check, no text, nothing loaded', () => {
  assert.ok(svg.startsWith('<svg'), 'the file starts with <svg (no XML prologue, no comment first)');
  assert.match(svg, /viewBox="0 0 64 64"/);
  assert.match(svg, /<rect width="64" height="64" rx="14" fill="#14532d"\/>/, 'the rounded square, rx 14 of 64 like the extension icon');
  assert.match(svg, /<path d="M[\d. ]+" fill="none" stroke="#ffffff" stroke-width="[\d.]+" stroke-linecap="round" stroke-linejoin="round"\/>/, 'the check: a white stroke with round caps and joins');
  assert.deepEqual(hexColours(svg).sort(), [GREEN, WHITE].sort(), 'names only the green and the white');
  assert.doesNotMatch(svg, /(fill|stroke)="(?!#14532d"|#ffffff"|none")/, 'every fill and stroke is the green, the white or none');
  assert.doesNotMatch(svg, /\b(rgb|hsl)a?\(|url\(/i, 'no other colour or reference');
  assert.doesNotMatch(svg, /<(text|script|style|image|foreignObject|a|use)\b/i, 'no text, script, style, image or link');
  const urls = [...svg.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0]);
  assert.deepEqual(urls, ['http://www.w3.org/2000/svg'], 'the only address is the SVG namespace, which names the format and is never fetched');
  assert.doesNotMatch(svg, FORBIDDEN);
  assert.doesNotMatch(svg, PILOT);
  assert.doesNotMatch(svg, OTHERS);
});

test('favicon-32.png and apple-touch-icon.png show the mark at their sizes; only the tab icon has transparent corners', () => {
  for (const { file, sizes, transparent } of FILES.filter((f) => !f.file.endsWith('.ico'))) {
    assert.ok(existsSync(path(file)), `${file} is missing: run npm run favicons`);
    const buf = readFileSync(path(file));
    assert.deepEqual(pngSize(buf), { width: sizes[0], height: sizes[0] }, `${file} size`);
    assert.doesNotThrow(() => checkMark(buf, sizes[0], transparent), `${file} does not show the mark as expected`);
    assert.ok(statSync(path(file)).size < 32 * 1024, `${file} is 32 KB or more`);
  }
  // the tab icon: transparent outside the rounded corner, opaque inside it
  const tab = pngPixels(readFileSync(path('site/favicon-32.png')));
  assert.equal(tab.pixel(0, 0)[3], 0, 'transparent corner');
  assert.equal(tab.pixel(31, 31)[3], 0, 'transparent corner, bottom right');
  assert.equal(tab.pixel(16, 2)[3], 255, 'opaque at the top edge, away from the corners');
  // the touch icon: iOS rounds it and shows black through transparency, so every corner is the green
  const touch = pngPixels(readFileSync(path('site/apple-touch-icon.png')));
  for (const [x, y] of [[0, 0], [179, 0], [0, 179], [179, 179]]) {
    const p = touch.pixel(x, y);
    assert.ok(p[3] === 255 && near(p, GREEN_RGB), `apple-touch-icon.png corner (${x}, ${y}) is not opaque green: ${p}`);
  }
  assert.ok(touch.pixel(77, 125).every((v, i) => (i === 3 ? v === 255 : v > 200)), 'the white check at the touch icon\'s size');
});

test('favicon.ico holds the 16 x 16 and 32 x 32 renderings as PNG entries, each showing the mark', () => {
  const ico = FILES.find((f) => f.file.endsWith('.ico'));
  assert.ok(existsSync(path(ico.file)), `${ico.file} is missing: run npm run favicons`);
  const buf = readFileSync(path(ico.file));
  const entries = parseIco(buf);
  assert.deepEqual(entries.map((e) => [e.width, e.height, e.bitCount]), [[16, 16, 32], [32, 32, 32]]);
  assert.deepEqual([...ico.sizes], [16, 32]);
  for (const e of entries) assert.doesNotThrow(() => checkMark(e.png, e.width, true), `the ${e.width} px entry does not show the mark`);
  assert.ok(buf.length < 16 * 1024, 'favicon.ico is 16 KB or more');
  assert.deepEqual([...SIZES], [16, 32, 180]);
});

test('icoFromPngs and parseIco round-trip, and refuse what is not theirs', () => {
  const a = fakePng(16, 16);
  const b = fakePng(32, 32);
  const ico = icoFromPngs([{ size: 16, png: a }, { size: 32, png: b }]);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 2);
  assert.equal(ico.readUInt32LE(6 + 12), 6 + 32, 'the first image follows the directory');
  const back = parseIco(ico);
  assert.deepEqual(back.map((e) => [e.width, e.height, e.bitCount]), [[16, 16, 32], [32, 32, 32]]);
  assert.ok(back[0].png.equals(a) && back[1].png.equals(b), 'the PNG bytes come back untouched');
  const big = icoFromPngs([{ size: 256, png: fakePng(256, 256) }]);
  assert.equal(big[6], 0, '256 is written as 0');
  assert.equal(parseIco(big)[0].width, 256);
  assert.throws(() => icoFromPngs([{ size: 16, png: b }]), /entry 0 is 32 x 32, not 16 x 16/);
  assert.throws(() => icoFromPngs([{ size: 16, png: Buffer.from('GIF89a' + ' '.repeat(40)) }]), /not a PNG/);
  assert.throws(() => icoFromPngs([]), /1 to 255/);
  assert.throws(() => icoFromPngs([{ size: 300, png: fakePng(300, 300) }]), /1 to 256/);
  assert.throws(() => parseIco(a), /not an ICO/);
  assert.throws(() => parseIco(ico.subarray(0, 20)), /not an ICO/);
  assert.throws(() => parseIco(ico.subarray(0, ico.length - 1)), /runs past the end/);
  assert.throws(() => pngSize(Buffer.alloc(8)), /not a PNG/);
  assert.throws(() => pngPixels(Buffer.from('GIF89a' + ' '.repeat(40))), /not a PNG/);
});

test('the share-image template says the name, a heading and the one line, in the site\'s colours, and loads nothing from elsewhere', () => {
  const heading = restingHeading(template);
  assert.equal(templateText(template), `Lot Current ${heading} ${LINE}`, 'the template says something besides the name, the heading and the line');
  assert.doesNotMatch(templateText(template), /\d/, 'no numbers on the image');
  assert.doesNotThrow(() => checkHeading({ slug: 'template', social: { heading } }));
  assert.match(template, /<html lang="en">/);
  assert.match(template, /<h2 id="heading">/);
  assert.doesNotMatch(template, OTHERS, 'the template names another company or its product');
  assert.doesNotMatch(template, FORBIDDEN);
  assert.doesNotMatch(template, PILOT);
  // the mark is the site's own favicon, from the repo, and nothing is loaded from elsewhere
  const srcs = [...template.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ['../../site/favicon.svg']);
  assert.ok(existsSync(new URL(srcs[0], path(TEMPLATE))), 'the mark\'s path resolves from the template');
  assert.doesNotMatch(template, /https?:\/\/|<script|<link|@import|@font-face|url\(/i, 'the template loads nothing');
  assert.match(template, /font-family: system-ui,/, 'the site\'s own font stack (site.css)');
  assert.match(css, /font: 16px\/1\.5 system-ui,/, 'site.css still starts its stack with system-ui');
  // every colour is one of the site's, and only the three the images are allowed
  const colours = hexColours(template);
  assert.deepEqual(colours.sort(), [GREEN, WHITE, SOFT].sort(), 'the template uses exactly the green, the white and the soft green');
  for (const c of colours) assert.ok(css.toLowerCase().includes(c), `${c} in the template is not one of site/site.css's colours`);
  assert.doesNotMatch(template, /\b(rgb|hsl)a?\(/i, 'no colour outside the three, by any other notation');
  assert.doesNotMatch(template, /\b(color|background):(?!\s*var\(--)/, 'every colour is set through the three variables');
  assert.match(template, /width: 1200px; height: 630px/, 'the page is the share image\'s size');
});

test('every page of the site map has a share image of 1200 x 630 under 300 KB, and images.json carries its alt sentence', () => {
  assert.ok(existsSync(path(IMAGES_JSON)), `${IMAGES_JSON} is missing: run npm run social-images`);
  const json = JSON.parse(read(IMAGES_JSON));
  assert.deepEqual(Object.keys(json), SOCIAL.map((p) => p.path), 'images.json lists exactly the pages with a share image, in map order');
  for (const { slug, path: pagePath } of SOCIAL) {
    const file = `${DIR}/${slug}.png`;
    assert.ok(existsSync(path(file)), `${file} is missing: run npm run social-images`);
    const buf = readFileSync(path(file));
    assert.deepEqual(pngSize(buf), SIZE, `${file} size`);
    assert.ok(buf.length <= SIZE_LIMIT, `${file} is ${(buf.length / 1024).toFixed(0)} KB, over ${SIZE_LIMIT / 1024} KB`);
    const { pixel } = pngPixels(buf);
    assert.ok(near(pixel(0, 0), GREEN_RGB) && pixel(0, 0)[3] === 255, `${file}: the background is not the green`);
    // the plate starts at the page's padding (72, 64) and is rounded: probe its top strip, clear of the corner and above the mark
    assert.ok(pixel(118, 68).every((v) => v > 240), `${file}: the white plate is not where the template puts it`);
    const entry = json[pagePath];
    assert.equal(entry.path, `/social/${slug}.png`, `${pagePath}: the image's path`);
    assert.equal(entry.width, SIZE.width);
    assert.equal(entry.height, SIZE.height);
    const m = String(entry.alt).match(/^The Lot Current check mark and name, with the words "(.+)" and "You click Publish\. Lot Current never does\."$/);
    assert.ok(m, `${pagePath}: the alt sentence has the agreed shape: ${entry.alt}`);
    assert.equal(entry.alt, altFor(m[1]));
    assert.doesNotThrow(() => checkHeading({ slug, social: { heading: m[1] } }), `${pagePath}: the heading in the alt`);
    assert.match(m[1], /\.$/, `${pagePath}: the heading is a sentence`);
  }
  const files = readdirSync(path(DIR)).sort();
  assert.deepEqual(files, [...SOCIAL.map((p) => `${p.slug}.png`), 'images.json'].sort(), `${DIR} holds exactly one PNG per page and images.json`);
  const text = read(IMAGES_JSON);
  assert.doesNotMatch(text, FORBIDDEN);
  assert.doesNotMatch(text, PILOT);
  assert.doesNotMatch(text, OTHERS);
});

test('the share-image helpers: the size and limit, the alt sentence, images.json, the heading rules', () => {
  assert.deepEqual(SIZE, { width: 1200, height: 630 });
  assert.equal(SIZE_LIMIT, 300 * 1024);
  assert.equal(MARGIN, 40);
  assert.equal(LINE, 'You click Publish. Lot Current never does.');
  assert.equal(altFor('Pricing.'), 'The Lot Current check mark and name, with the words "Pricing." and "You click Publish. Lot Current never does."');
  const pages = [
    { slug: 'home', path: '/', social: { heading: 'One.' } },
    { slug: 'not-found', path: '/404.html', social: null },
    { slug: 'faq', path: '/faq/', social: { heading: 'Two.' } },
  ];
  assert.deepEqual(socialPages(pages).map((p) => p.slug), ['home', 'faq']);
  assert.deepEqual(JSON.parse(imagesJson(pages)), {
    '/': { path: '/social/home.png', width: 1200, height: 630, alt: altFor('One.') },
    '/faq/': { path: '/social/faq.png', width: 1200, height: 630, alt: altFor('Two.') },
  });
  assert.ok(imagesJson(pages).endsWith('}\n'));
  assert.equal(checkHeading(pages[0]), 'One.');
  assert.throws(() => checkHeading({ slug: 'x', social: { heading: '' } }), /no social heading/);
  assert.throws(() => checkHeading({ slug: 'x' }), /no social heading/);
  assert.throws(() => checkHeading({ slug: 'x', social: { heading: 'Posts in 10 seconds.' } }), /has a number/);
  assert.throws(() => checkHeading({ slug: 'x', social: { heading: 'Facebook made easy.' } }), /names another company/);
  assert.throws(() => checkHeading({ slug: 'x', social: { heading: 'Meta approved.' } }), /names another company/);
  assert.throws(() => checkHeading({ slug: 'x', social: { heading: 'x'.repeat(71) } }), /at most 70/);
  assert.throws(() => socialPngSize(Buffer.from('GIF89a' + ' '.repeat(40))), /not a PNG/);
  assert.equal(templateText('<html><body><!-- no --><h1>Lot Current</h1> <p>A &amp; B</p></body></html>'), 'Lot Current A & B');
  assert.throws(() => restingHeading('<html><body><h2>no id</h2></body></html>'), /no <h2 id="heading">/);
});
