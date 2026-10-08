// The browser half of the dealer-branding crop (extension/src/photoCanvas.js)
// and how the side panel uses it:
//   - crop only: the one picture made to send is an exact sub-rectangle of
//     the website's photo, one drawImage of the plan's rectangle onto a
//     canvas of that size; nothing is painted, filled, filtered, blended or
//     written on (the guard reads the file and fails on any other drawing);
//   - a photo is cut only from the very bytes that were checked (sha and
//     size), so a photo the website changed since goes as the website shows it;
//   - only JPEG, PNG, WebP and AVIF are decoded; the photo's own
//     orientation is applied, as a browser shows it;
//   - the side panel cuts only through cropPhoto, and only in forTheForm,
//     which every photo for the form or the Downloads folder goes through.
// The pixels themselves are drawn in Chromium in test/e2e/branding.e2e.mjs;
// here the canvas is a recording stand-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { samplePhoto, cropPhoto } from '../extension/src/photoCanvas.js';
import { cropPlan, checkSize } from '../extension/src/photoBranding.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([;{}),])\s*\/\/[^\n]*$/gm, '$1');
// A top-level function's text, from its declaration to the closing brace at the start of a line.
function fnText(src, name) {
  const start = src.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} is defined`);
  return src.slice(start, src.indexOf('\n}\n', start) + 2);
}

// ---------- the guard: nothing drawn but the crop ----------

// Everything a 2D canvas can do to pixels besides copying a rectangle of a
// picture, and every way to read a canvas out other than convertToBlob.
const DRAWING = [
  'fillRect', 'strokeRect', 'clearRect', 'fillText', 'strokeText', 'putImageData', 'createImageData', 'fillStyle', 'strokeStyle',
  'globalAlpha', 'globalCompositeOperation', 'filter', 'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY',
  'beginPath', 'closePath', 'moveTo', 'lineTo', 'rect', 'roundRect', 'arc', 'arcTo', 'ellipse', 'bezierCurveTo', 'quadraticCurveTo', 'fill', 'stroke', 'clip',
  'transform', 'setTransform', 'resetTransform', 'rotate', 'scale', 'translate', 'createPattern', 'createLinearGradient', 'createRadialGradient', 'createConicGradient',
  'drawFocusIfNeeded', 'font', 'textAlign', 'textBaseline', 'lineWidth', 'toDataURL', 'toBlob', 'transferToImageBitmap', 'transferControlToOffscreen', 'reset',
  'getContextAttributes', 'bitmaprenderer', 'webgl', 'webgl2', 'webgpu',
];

test('photoCanvas.js draws nothing but the crop: one drawImage of the plan\'s rectangle onto a canvas that size, and the check\'s small copy', () => {
  const src = stripComments(read('../extension/src/photoCanvas.js'));
  for (const word of DRAWING) assert.doesNotMatch(src, new RegExp(`\\.${word}\\b|['"]${word}['"]`), `photoCanvas.js uses ${word}`);
  assert.doesNotMatch(src, /\bdocument\b|\bwindow\b|createElement|<canvas|\bnew ImageData\(|new Image\b/, 'no page canvas, no image element, no ImageData of its own');
  // every member used on a canvas or its context is one of these
  const members = [...src.matchAll(/\b(?:ctx|canvas)\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(members)].sort(), ['convertToBlob', 'drawImage', 'getContext', 'getImageData', 'imageSmoothingEnabled', 'imageSmoothingQuality']);
  // exactly two drawImage calls, written out
  const draws = [...src.matchAll(/drawImage\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(draws, ['bitmap, 0, 0, size.w, size.h', 'bitmap, plan.x, plan.y, plan.w, plan.h, 0, 0, plan.w, plan.h']);
  // the check's copy: drawn at checkSize, read with getImageData, never encoded or sent
  const sample = fnText(src, 'samplePhoto');
  assert.match(sample, /const canvas = new OffscreenCanvas\(size\.w, size\.h\);/);
  assert.match(sample, /ctx\.drawImage\(bitmap, 0, 0, size\.w, size\.h\);/);
  assert.doesNotMatch(sample, /convertToBlob|dataUrlOf/, 'the check\'s copy is never encoded');
  assert.match(sample, /createImageBitmap|decode\(/);
  // the crop: a canvas exactly the plan's size, the one drawImage of that rectangle, then encoded
  const crop = fnText(src, 'cropPhoto');
  assert.match(crop, /const canvas = new OffscreenCanvas\(plan\.w, plan\.h\);\n\s*canvas\.getContext\('2d'\)\.drawImage\(bitmap, plan\.x, plan\.y, plan\.w, plan\.h, 0, 0, plan\.w, plan\.h\);\n\s*const blob = await canvas\.convertToBlob\(/, 'nothing between the copy of the rectangle and the encoding');
  assert.equal((src.match(/new OffscreenCanvas\(/g) || []).length, 2);
  assert.equal((src.match(/getContext\(/g) || []).length, 2);
  // the bytes are checked before anything is cut, and every bitmap is closed
  assert.ok(crop.indexOf('matchesCheck(plan,') > 0 && crop.indexOf('matchesCheck(plan,') < crop.indexOf('new OffscreenCanvas('), 'matchesCheck comes before the canvas');
  for (const name of ['samplePhoto', 'cropPhoto']) assert.match(fnText(src, name), /finally \{\n\s*if \(bitmap\) bitmap\.close\(\);\n\s*\}/, `${name} closes its bitmap`);
  // orientation as the browser shows the photo, and only the formats Chrome decodes into pixels
  assert.match(src, /createImageBitmap\(new Blob\(\[bytes\], \{ type \}\), \{ imageOrientation: 'from-image' \}\)/);
  assert.match(src, /const DECODED = new Set\(\['image\/jpeg', 'image\/png', 'image\/webp', 'image\/avif'\]\);/);
  // no fetch of the data: address (the base64 is decoded by hand), nothing sent anywhere
  assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|sendMessage|chrome\./);
});

test('the side panel cuts photos only through cropPhoto, in forTheForm, which every photo for the form or the Downloads folder goes through', () => {
  const src = stripComments(read('../extension/sidepanel.js'));
  assert.doesNotMatch(src, /OffscreenCanvas|getContext\(|drawImage|createImageBitmap|convertToBlob|toDataURL|putImageData|<canvas|createElement\('canvas'\)/, 'no canvas work in sidepanel.js itself');
  assert.match(src, /^import \{ samplePhoto, cropPhoto \} from '\.\/src\/photoCanvas\.js';$/m);
  assert.equal((src.match(/\bcropPhoto\(/g) || []).length, 1, 'cropPhoto is called once');
  assert.match(fnText(src, 'forTheForm'), /const plan = brandingOn\(\) \? cropPlan\(brandingEntry\(f\.url\), \{ url: f\.url, originals: state\.photoOriginals \|\| \[\] \}\) : null;/, 'only with the setting on, and never for a photo set back');
  assert.match(fnText(src, 'forTheForm'), /await cropPhoto\(f\.dataUrl, plan\)/);
  assert.equal((src.match(/\bsamplePhoto\(/g) || []).length, 1, 'samplePhoto is called once, by the check');
  assert.match(fnText(src, 'readForBranding'), /await samplePhoto\(p\.dataUrl\)/);
  // forTheForm: attachPhotos and downloadPhotos only, and what they hand on is its output
  const uses = [...src.matchAll(/\bforTheForm\(/g)].length;
  assert.equal(uses, 3, 'defined once, used by attachPhotos and downloadPhotos');
  const attach = fnText(src, 'attachPhotos');
  assert.match(attach, /const files = await forTheForm\(good, mine\);\n\s*if \(!current\(\)\) return;/);
  assert.match(attach, /func: attachPhotosInPage, args: \[state\.map, files\]/, 'the form gets forTheForm\'s files');
  const download = fnText(src, 'downloadPhotos');
  assert.match(download, /const files = await forTheForm\(/);
  assert.match(download, /for \(const p of files\) \{/, 'the Downloads folder gets forTheForm\'s files');
  // the thumbnail shows a crop only where forTheForm would cut one
  assert.match(fnText(src, 'photoPickHtml'), /const view = goesCropped\(url\) \? insetOf\(e\) : '';/);
  assert.match(src, /^const goesCropped = \(url\) => brandingOn\(\) && Boolean\(cropPlan\(brandingEntry\(url\), \{ url, originals: state\.photoOriginals \|\| \[\] \}\)\);$/m);
});

// ---------- the module, with a recording stand-in for the browser's canvas ----------

const png = (w, h) => {
  // a PNG header with the size in it: enough for the stand-in, which reads only the size
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const dataUrl = (bytes, type = 'image/png') => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function standIn() {
  const log = [];
  let open = 0;
  globalThis.createImageBitmap = async (blob, options) => {
    const bytes = Buffer.from(await blob.arrayBuffer());
    if (bytes.subarray(1, 4).toString('latin1') !== 'PNG') throw new Error('not a picture');
    open += 1;
    log.push(['bitmap', blob.type, options]);
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), close() { open -= 1; } };
  };
  globalThis.OffscreenCanvas = class {
    constructor(w, h) {
      this.width = w;
      this.height = h;
      log.push(['canvas', w, h]);
    }
    getContext(kind, options) {
      log.push(['context', kind, options || null]);
      const canvas = this;
      return new Proxy({}, {
        get(_, name) {
          if (name === 'drawImage') return (...args) => log.push(['drawImage', ...args.slice(1)]);
          if (name === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
          throw new Error(`the canvas was asked for ${String(name)}`);
        },
        set(_, name, value) {
          log.push(['set', name, value]);
          return true;
        },
      });
    }
    async convertToBlob(options) {
      log.push(['encode', options.type, options.quality]);
      return new Blob([png(this.width, this.height)], { type: options.type });
    }
  };
  return { log, open: () => open };
}

test('samplePhoto reads JPEG, PNG, WebP and AVIF at the check size, turned the way the photo says; anything else is not checked', async () => {
  const s = standIn();
  const bytes = png(640, 480);
  const r = await samplePhoto(dataUrl(bytes));
  const size = checkSize(640, 480);
  assert.deepEqual([r.ok, r.width, r.height, r.w, r.h, r.rgba.length, r.sha, r.type], [true, 640, 480, size.w, size.h, size.w * size.h * 4, sha(bytes), 'image/png']);
  assert.deepEqual(s.log.find((l) => l[0] === 'bitmap'), ['bitmap', 'image/png', { imageOrientation: 'from-image' }]);
  assert.deepEqual(s.log.filter((l) => l[0] === 'drawImage'), [['drawImage', 0, 0, size.w, size.h]]);
  assert.ok(!s.log.some((l) => l[0] === 'encode'), 'the check\'s copy is never encoded');
  assert.equal(s.open(), 0, 'the bitmap is closed');
  // too small to check: no pixels, findBranding says why
  const small = await samplePhoto(dataUrl(png(1, 1)));
  assert.deepEqual([small.ok, small.width, small.height, small.w, small.h, small.rgba], [true, 1, 1, 0, 0, null]);
  // not decoded at all
  assert.deepEqual(await samplePhoto(dataUrl(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml')), { ok: false, reason: 'format' });
  assert.deepEqual(await samplePhoto(dataUrl(Buffer.from('GIF89a'), 'image/gif')), { ok: false, reason: 'format' });
  assert.deepEqual(await samplePhoto('https://img.example.test/1.jpg'), { ok: false, reason: 'decode' }, 'only a data: address the worker made');
  assert.deepEqual(await samplePhoto('data:image/jpeg;base64,not base64!'), { ok: false, reason: 'decode' });
  assert.deepEqual(await samplePhoto(dataUrl(Buffer.from('garbage'), 'image/jpeg')), { ok: false, reason: 'decode' }, 'a photo that does not decode');
  assert.equal(s.open(), 0);
});

test('cropPhoto cuts exactly the plan\'s rectangle from the bytes that were checked, and refuses a photo that changed', async () => {
  const s = standIn();
  const bytes = png(640, 480);
  const entry = { status: 'cropped', crop: { x: 0, y: 0, w: 640, h: 432 }, width: 640, height: 480, sides: ['bottom'], bands: ['bottom'], left: null, marks: 0, reason: null, sha: sha(bytes), type: 'image/png' };
  const plan = cropPlan(entry, { url: 'u' });
  const r = await cropPhoto(dataUrl(bytes), plan);
  assert.deepEqual([r.ok, r.type, r.width, r.height], [true, 'image/png', 640, 432]);
  assert.match(r.dataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(Buffer.from(r.dataUrl.split(',')[1], 'base64').readUInt32BE(20), 432, 'the file made is the crop\'s size');
  assert.deepEqual(s.log.filter((l) => ['canvas', 'drawImage', 'encode'].includes(l[0])), [['canvas', 640, 432], ['drawImage', 0, 0, 640, 432, 0, 0, 640, 432], ['encode', 'image/png', 0.92]]);
  assert.ok(!s.log.some((l) => l[0] === 'set'), 'nothing about the drawing is changed for the crop');
  assert.equal(s.open(), 0);
  // a JPEG stays a JPEG; an AVIF becomes a JPEG (Chrome can't write AVIF)
  s.log.length = 0;
  await cropPhoto(dataUrl(bytes, 'image/jpeg'), plan);
  assert.deepEqual(s.log.find((l) => l[0] === 'encode'), ['encode', 'image/jpeg', 0.92]);
  s.log.length = 0;
  await cropPhoto(dataUrl(bytes, 'image/avif'), plan);
  assert.deepEqual(s.log.find((l) => l[0] === 'encode'), ['encode', 'image/jpeg', 0.92]);

  // the website changed the photo since the check: other bytes, or the same bytes said to be another size
  s.log.length = 0;
  assert.deepEqual(await cropPhoto(dataUrl(png(640, 481)), plan), { ok: false, reason: 'changed' });
  assert.ok(!s.log.some((l) => l[0] === 'canvas'), 'nothing is cut');
  assert.deepEqual(await cropPhoto(dataUrl(bytes), { ...plan, height: 600 }), { ok: false, reason: 'changed' });
  assert.deepEqual(await cropPhoto(dataUrl(bytes), { ...plan, sha: null }), { ok: false, reason: 'changed' }, 'a check that kept no fingerprint cuts nothing');
  assert.deepEqual(await cropPhoto(dataUrl(bytes), null), { ok: false, reason: 'changed' });
  assert.deepEqual(await cropPhoto(dataUrl(Buffer.from('<svg/>'), 'image/svg+xml'), plan), { ok: false, reason: 'changed' }, 'never a format the check could not read');
  assert.ok(!s.log.some((l) => l[0] === 'canvas'), 'still nothing cut');
  assert.equal(s.open(), 0);
});
