// The Web Store promo images (store/listing.md, Promo tile): the two PNGs in
// store/images/ are the sizes the store takes, the page they are drawn from
// says the name and the listing's line and nothing else, nothing of Meta's
// is in it (legal/trademark-note.md), and the listing names the files and the
// script that draws them (scripts/store-images.mjs). No browser needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { IMAGES, pngSize, promoLine, tileText } from '../scripts/store-images.mjs';

const path = (rel) => new URL(rel, import.meta.url);
const read = (rel) => readFileSync(path(rel), 'utf8');
const listing = read('../store/listing.md');
const tile = read('../store/images/tile.html');
const css = read('../site/site.css');

const LINE = 'You click Publish. Lot Current never does.';
const FILES = [
  { name: 'promo-small-440x280.png', width: 440, height: 280 },
  { name: 'promo-marquee-1400x560.png', width: 1400, height: 560 },
];
const MB = 1024 * 1024;
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function section(md, heading) {
  const start = md.indexOf(heading);
  assert.ok(start >= 0, `store/listing.md has no "${heading}" section`);
  const end = md.indexOf('\n## ', start + heading.length);
  return md.slice(start, end > 0 ? end : undefined);
}

// The page as the image shows it: the body's text only.
function visible(html) {
  const body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [, ''])[1];
  return body.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

test('each promo image exists, is a PNG of the exact size, and is under 1 MB', () => {
  for (const { name, width, height } of FILES) {
    const url = path(`../store/images/${name}`);
    assert.ok(existsSync(url), `store/images/${name} is missing: run node scripts/store-images.mjs`);
    const buf = readFileSync(url);
    assert.deepEqual([...buf.subarray(0, 8)], SIGNATURE, `${name} is not a PNG`);
    assert.equal(buf.toString('ascii', 12, 16), 'IHDR', `${name} has no IHDR chunk first`);
    assert.equal(buf.readUInt32BE(16), width, `${name} width`);
    assert.equal(buf.readUInt32BE(20), height, `${name} height`);
    assert.ok(statSync(url).size < MB, `${name} is 1 MB or more`);
  }
});

test('the tile says the name and the listing\'s line word for word, and nothing else', () => {
  const quoted = section(listing, '## Promo tile').match(/the one line "([^"]+)"/);
  assert.ok(quoted, 'the Promo tile section quotes the one line');
  assert.equal(quoted[1], LINE, 'the listing\'s line changed: change tile.html, this test and the images together');
  const text = visible(tile);
  assert.ok(text.includes(LINE), 'tile.html does not carry the listing\'s line word for word');
  assert.ok(text.includes('Lot Current'), 'tile.html does not carry the name');
  assert.equal(text, `Lot Current ${LINE}`, 'tile.html says something besides the name and the line');
  assert.doesNotMatch(text, /\d/, 'no numbers on the tile');
});

test('the tile names neither Facebook, Meta nor Marketplace and uses only the extension\'s icon and the product\'s colours', () => {
  assert.doesNotMatch(tile, /Facebook|Marketplace|\bMeta\b/, 'tile.html names Meta or its products');
  assert.doesNotMatch(visible(tile), /facebook|marketplace|\bmeta\b/i);
  // the icon is the extension's own, from the repo, and nothing is loaded from elsewhere
  const srcs = [...tile.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ['../../extension/icons/icon128.png']);
  assert.ok(existsSync(path('../store/images/' + srcs[0])), 'the icon path resolves');
  assert.doesNotMatch(tile, /https?:\/\/|<script|<link/i, 'tile.html loads nothing');
  // every colour is one of the landing page's, so no brand colour of anyone else's slips in
  const colours = [...new Set([...tile.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0].toLowerCase()))];
  assert.ok(colours.length >= 2);
  for (const c of colours) assert.ok(css.toLowerCase().includes(c), `${c} in tile.html is not one of site/site.css's colours`);
});

test('the listing names the script, the folder and both files, and the checklist mentions them', () => {
  const promo = section(listing, '## Promo tile');
  for (const s of ['`node scripts/store-images.mjs`', '`store/images/`', '`store/images/tile.html`', ...FILES.map((f) => '`' + f.name + '`')]) {
    assert.ok(promo.includes(s), `the Promo tile section does not name ${s}`);
  }
  assert.match(promo, /may replace/, 'the owner may replace the drafts');
  const checklist = section(listing, '## Before submitting');
  const item = checklist.split('\n').find((l) => l.startsWith('- [ ] ') && l.includes('store/images/'));
  assert.ok(item, 'no checklist line names store/images/');
  for (const { name } of FILES) assert.ok(item.includes(name), `the checklist line does not name ${name}`);
  assert.ok(item.includes('node scripts/store-images.mjs'));
});

test('the script draws the same two files, reads the PNG header, and takes the line from the listing', () => {
  assert.deepEqual(IMAGES.map(({ name, width, height }) => ({ name, width, height })), FILES);
  for (const { name, width, height } of FILES) assert.deepEqual(pngSize(readFileSync(path(`../store/images/${name}`))), { width, height });
  assert.throws(() => pngSize(Buffer.from('GIF89a' + ' '.repeat(40))), /not a PNG/);
  assert.throws(() => pngSize(Buffer.alloc(8)), /not a PNG/);
  assert.equal(promoLine(listing), LINE);
  assert.throws(() => promoLine('# Listing\n\n## Summary\n'), /Promo tile/);
  assert.equal(tileText(tile), visible(tile));
});
