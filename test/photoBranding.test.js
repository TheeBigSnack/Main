// The dealer-branding check (extension/src/photoBranding.js), on synthetic
// check samples built here: no browser, no real photos. Each gallery is a
// set of different photo-like pictures with the same vendor overlay painted
// over them at the same pixels, the way a photo vendor's PNG is laid on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_LONG_SIDE, LOT_LONG_SIDE, MIN_PHOTOS, MIN_SIDE, MAX_CHECK_PHOTOS, COVER_SAMPLE_CARS, TUNING,
  checkSize, findBranding, lotSample, withCover, otherCovers, cropPlan, matchesCheck, insetOf, fileNameFor,
  brandingSummary, photoNote,
} from '../extension/src/photoBranding.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A photo-like sample: a smooth random gradient, a few shapes, some noise.
function photo(seed, w = 256, h = 192) {
  const r = rng(seed);
  const c = () => [r() * 255, r() * 255, r() * 255];
  const [a, b, d, e] = [c(), c(), c(), c()];
  const shapes = Array.from({ length: 6 }, () => ({ x: r() * w, y: r() * h, rad: 10 + r() * 50, col: c() }));
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const v = y / h;
      const o = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) {
        let val = a[k] * (1 - u) * (1 - v) + b[k] * u * (1 - v) + d[k] * (1 - u) * v + e[k] * u * v;
        for (const s of shapes) if ((x - s.x) ** 2 + (y - s.y) ** 2 < s.rad ** 2) val = s.col[k];
        px[o + k] = val + (r() - 0.5) * 16;
      }
      px[o + 3] = 255;
    }
  }
  return px;
}

// The vendor's overlay: opaque pixels over the photo, the same in every one.
function paint(px, w, fn) {
  const h = px.length / 4 / w;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const col = fn(x, y);
      if (!col) continue;
      const o = (y * w + x) * 4;
      px[o] = col[0];
      px[o + 1] = col[1];
      px[o + 2] = col[2];
    }
  }
  return px;
}
// a dark bottom band (rows 165 and down) with white "text" in it
const band = (x, y) => (y < 165 ? null : y >= 172 && y < 184 && (x >> 2) % 3 === 0 && x > 20 && x < 200 ? [250, 250, 250] : [18, 30, 52]);
// a white badge with dark "lettering" in the top-left corner
const badge = (x, y) => (x >= 5 && x < 43 && y >= 4 && y < 23 ? (y >= 10 && y < 17 && (x >> 1) % 3 === 0 ? [20, 30, 60] : [250, 250, 250]) : null);
// an opaque logo in the middle of the photo
const centre = (x, y) => (x >= 100 && x < 150 && y >= 110 && y < 140 ? ((x + y) >> 2) % 2 ? [200, 20, 30] : [250, 250, 250] : null);
// a cover-only banner along the top
const banner = (x, y) => (y < 30 ? (y >= 8 && y < 20 && (x >> 3) % 2 === 0 ? [255, 214, 10] : [200, 0, 0]) : null);
// a top bar with lettering and the bottom band
const topBar = (x, y) => (y < 14 ? (y >= 4 && y < 10 && (x >> 2) % 3 === 0 && x > 30 && x < 220 ? [250, 250, 250] : [120, 0, 20]) : null);
const topAndBottom = (x, y) => topBar(x, y) || band(x, y);
// a frame: plain sides and top, and a deeper bottom with lettering
const frame = (x, y) => {
  if (y >= 170) return y >= 176 && y < 186 && (x >> 2) % 3 === 0 && x > 40 && x < 216 ? [250, 250, 250] : [10, 60, 30];
  return x < 8 || x >= 248 || y < 8 ? [10, 60, 30] : null;
};

// A check sample of a 1024x768 photo drawn at 256x192 (4 natural px per check px).
const sample = (id, px, width = 1024, height = 768, w = 256, h = 192) => ({ id, width, height, w, h, rgba: px });

function gallery(n, overlay, { seed = 1, skip = [] } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const px = photo(seed * 100 + i);
    if (overlay && !skip.includes(i)) paint(px, 256, overlay);
    return sample(`p${i + 1}`, px);
  });
}

// The check pixels an overlay covers, at the 256x192 grid.
function overlayPixels(fn, w = 256, h = 192) {
  const out = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (fn(x, y)) out.push([x, y]);
  return out;
}

// A crop is an exact, honest sub-rectangle: integers, inside the photo, at
// least 60% of it, and none of the overlay's natural pixels inside (each
// check pixel is a 4x4 block of the 1024x768 photo).
function assertHonestCrop(e, overlay, label = '') {
  const { x, y, w, h } = e.crop;
  for (const v of [x, y, w, h]) assert.ok(Number.isInteger(v), `${label} crop ${JSON.stringify(e.crop)} is in whole pixels`);
  assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= e.width && y + h <= e.height, `${label} crop ${JSON.stringify(e.crop)} is inside the photo`);
  assert.ok(w * h >= 0.6 * e.width * e.height, `${label} crop keeps ${((w * h) / (e.width * e.height)).toFixed(3)} of the photo`);
  if (!overlay || e.left) return;
  const fx = e.width / 256;
  const fy = e.height / 192;
  for (const [ox, oy] of overlayPixels(overlay)) {
    const inX = ox * fx < x + w && (ox + 1) * fx > x;
    const inY = oy * fy < y + h && (oy + 1) * fy > y;
    assert.ok(!(inX && inY), `${label} crop ${JSON.stringify(e.crop)} keeps the overlay pixel at check ${ox},${oy}`);
  }
}

// ---------- ported from the measured spike ----------

test('constants are the contract values', () => {
  assert.equal(CHECK_LONG_SIDE, 256);
  assert.equal(LOT_LONG_SIDE, 128);
  assert.equal(MIN_PHOTOS, 4);
  assert.equal(MIN_SIDE, 200);
  assert.equal(MAX_CHECK_PHOTOS, 40);
  assert.equal(COVER_SAMPLE_CARS, 8);
});

test('checkSize keeps the aspect, never upscales, refuses small or broken sizes', () => {
  assert.deepEqual(checkSize(1024, 768), { w: 256, h: 192 });
  assert.deepEqual(checkSize(768, 1024), { w: 192, h: 256 });
  assert.deepEqual(checkSize(1920, 1080), { w: 256, h: 144 });
  assert.deepEqual(checkSize(240, 200), { w: 240, h: 200 });
  assert.equal(checkSize(199, 300), null);
  assert.equal(checkSize(1, 1), null);
  assert.equal(checkSize(NaN, 768), null);
  assert.equal(checkSize(undefined, undefined), null);
});

test('lotSample is a 2x2 box average in RGB', () => {
  const rgba = new Uint8ClampedArray(4 * 2 * 4);
  const set = (x, y, v) => rgba.set([v, v + 1, v + 2, 255], (y * 4 + x) * 4);
  set(0, 0, 10); set(1, 0, 20); set(0, 1, 30); set(1, 1, 40);
  set(2, 0, 100); set(3, 0, 100); set(2, 1, 100); set(3, 1, 100);
  const s = lotSample({ width: 1000, height: 500, w: 4, h: 2, rgba });
  assert.equal(s.w, 2);
  assert.equal(s.h, 1);
  assert.equal(s.width, 1000);
  assert.equal(s.height, 500);
  assert.ok(s.rgb instanceof Uint8Array);
  assert.deepEqual([...s.rgb], [25, 26, 27, 100, 101, 102]);
  const full = lotSample(gallery(1, null)[0]);
  assert.deepEqual([full.w, full.h, full.rgb.length], [128, 96, 128 * 96 * 3], 'a check sample becomes at most LOT_LONG_SIDE across');
});

test('no overlay: every photo is checked and none is cropped', () => {
  const res = findBranding(gallery(12, null));
  for (const e of Object.values(res.photos)) assert.deepEqual([e.status, e.crop, e.left, e.reason], ['none', null, null, null]);
  assert.deepEqual(res.counts, { cropped: 0, kept: 0, none: 12, unchecked: 0, inside: 0 });
  assert.equal(brandingSummary(res.photos, Object.keys(res.photos)), 'Lot Current found no logo band, frame or corner logo repeating across these photos; they go on as the website shows them.');
  // nothing found is not the same as no branding: no note at all
  assert.equal(photoNote(res.photos.p1), '');
});

test('a bottom band on every photo is cropped off, and only the band', () => {
  const res = findBranding(gallery(12, band));
  for (const e of Object.values(res.photos)) {
    assert.equal(e.status, 'cropped');
    assert.equal(e.left, null);
    assert.deepEqual(e.sides, ['bottom']);
    assert.deepEqual(e.bands, ['bottom']);
    assert.deepEqual([e.crop.x, e.crop.y, e.crop.w, e.width, e.height], [0, 0, 1024, 1024, 768]);
    // the band starts at check row 165 = natural row 660; at most a few rows more are cut
    assert.ok(e.crop.h <= 660 && e.crop.h >= 640, `crop height ${e.crop.h}`);
    assertHonestCrop(e, band);
  }
  assert.equal(res.counts.cropped, 12);
  assert.equal(brandingSummary(res.photos, Object.keys(res.photos)), 'Cropped the same logo band off the bottom of 12 of 12 photos. Check each one; Use original puts a photo back as the website shows it.');
  assert.equal(photoNote(res.photos.p1), 'Cropped: logo band off the bottom');
});

test('the blended line along a band\'s inner edge is cut too', () => {
  // the vendor's PNG is anti-aliased: row 164 is half band, half photo, so it differs from photo to photo
  const g = gallery(10, band, { seed: 2 });
  for (const p of g) for (let x = 0; x < 256; x++) {
    const o = (164 * 256 + x) * 4;
    p.rgba[o] = (p.rgba[o] + 18) >> 1;
    p.rgba[o + 1] = (p.rgba[o + 1] + 30) >> 1;
    p.rgba[o + 2] = (p.rgba[o + 2] + 52) >> 1;
  }
  const res = findBranding(g);
  for (const e of Object.values(res.photos)) {
    assert.equal(e.status, 'cropped');
    assert.ok(e.crop.y + e.crop.h <= 164 * 4, `the crop ends at natural row ${e.crop.y + e.crop.h}, inside the blended line`);
  }
});

test('a photo without the overlay is never cropped, inside a gallery that has it', () => {
  const res = findBranding(gallery(12, band, { skip: [4] }));
  assert.deepEqual([res.photos.p5.status, res.photos.p5.crop, res.photos.p5.sides], ['none', null, []]);
  for (const id of ['p1', 'p4', 'p6', 'p12']) assert.equal(res.photos[id].status, 'cropped');
  assert.equal(res.counts.cropped, 11);
});

test('a photo without the overlay is never cropped where its own edge matches a plain bar of the overlay', () => {
  // the overlay: a plain white bar along the top (no text in it) and the lettered bottom band
  const bar = (x, y) => (y < 8 ? [255, 255, 255] : null);
  const overlay = (x, y) => bar(x, y) || band(x, y);
  for (const sky of [[254, 254, 254], [2, 2, 2]]) {
    const g = gallery(10, sky[0] > 128 ? overlay : (x, y) => (y < 8 ? [0, 0, 0] : band(x, y)), { seed: 9, skip: [6] });
    // p7 carries none of it, but its top is an overcast white sky (or a dark ceiling) where the bar sits
    paint(g[6].rgba, 256, (x, y) => (y < 40 ? sky.map((v) => v + ((x + y) % 3) - 1) : null));
    const res = findBranding(g);
    assert.deepEqual([res.photos.p7.status, res.photos.p7.crop, res.photos.p7.sides], ['none', null, []], `sky ${sky}`);
    assert.equal(photoNote(res.photos.p7), '');
    for (const id of ['p1', 'p6', 'p8']) {
      assert.equal(res.photos[id].status, 'cropped', `${id} carries the overlay`);
      assert.deepEqual(res.photos[id].bands, ['top', 'bottom']);
    }
    assert.equal(res.counts.cropped, 9);
  }
});

test('a corner badge is stepped around, and the crop holds none of it', () => {
  const res = findBranding(gallery(10, badge, { seed: 3 }));
  for (const e of Object.values(res.photos)) {
    assert.equal(e.status, 'cropped');
    assert.equal(e.left, null);
    assert.deepEqual(e.bands, [], 'a badge is not a band');
    assert.equal(e.marks, 1);
    const below = e.crop.y >= 23 * 4;
    const right = e.crop.x >= 43 * 4;
    assert.ok(below || right, JSON.stringify(e.crop));
    assertHonestCrop(e, badge);
  }
  assert.match(brandingSummary(res.photos, Object.keys(res.photos)), /^Cropped the same corner logo off the top of 10 of 10 photos\./);
  assert.equal(photoNote(res.photos.p1), 'Cropped: corner logo off the top');
});

test('a band and a corner logo on another side are each named for the side they came off', () => {
  const both = (x, y) => band(x, y) || badge(x, y);
  const res = findBranding(gallery(10, both, { seed: 4 }));
  for (const e of Object.values(res.photos)) {
    assert.equal(e.status, 'cropped');
    assert.deepEqual([e.sides, e.bands, e.markSides, e.marks, e.left], [['top', 'bottom'], ['bottom'], ['top'], 1, null], JSON.stringify(e));
    assertHonestCrop(e, both);
  }
  assert.equal(photoNote(res.photos.p1), 'Cropped: logo band off the bottom and a corner logo off the top');
  assert.equal(photoNote(res.photos.p1, { original: true }), 'Original: logo band and corner logo left on');
  assert.match(brandingSummary(res.photos, Object.keys(res.photos)), /^Cropped the same logo band off the bottom and a corner logo off the top of 10 of 10 photos\./);
  assert.match(brandingSummary(res.photos, Object.keys(res.photos), { originals: ['p2'] }), /You set 1 photo back to the website's original, with the logo band and corner logo left on\./);
  // an entry saved before markSides existed: its other side was a corner logo's when it had one
  const { markSides, ...old } = res.photos.p1;
  assert.equal(photoNote(old), 'Cropped: logo band off the bottom and a corner logo off the top');
});

test('a side cut only to keep the photo\'s shape is not called a logo band side', () => {
  // a lettered top bar and bottom band that leave a strip too wide: the crop narrows it to keep the shape
  const lettered = (x, y, r0, col) => (y >= r0 + 6 && y < r0 + 14 && (x >> 2) % 3 === 0 && x > 30 && x < 220 ? [250, 250, 250] : col);
  const bars = (x, y) => (y < 30 ? lettered(x, y, 0, [120, 0, 20]) : y >= 160 ? lettered(x, y, 160, [18, 30, 52]) : null);
  const res = findBranding(gallery(10, bars, { seed: 9 }));
  const e = res.photos.p1;
  assert.equal(e.status, 'cropped');
  assert.deepEqual([e.sides, e.bands, e.markSides], [['top', 'right', 'bottom', 'left'], ['top', 'bottom'], []], JSON.stringify(e));
  assert.equal(photoNote(e), "Cropped: logo bands off the top and the bottom and a strip off the right side and the left side to keep the photo's shape");
  assertHonestCrop(e, bars);
});

test('an opaque logo in the middle is kept: cropping it off would cost too much, and nothing says it is gone', () => {
  const res = findBranding(gallery(10, centre, { seed: 4 }));
  for (const e of Object.values(res.photos)) {
    assert.equal(e.status, 'kept');
    assert.equal(e.left, 'inside', 'the logo stays inside the photo');
    assert.equal(e.crop, null);
    assert.equal(cropPlan({ ...e, sha: 'ab' }, { url: 'u' }), null, 'a kept photo goes as the website shows it');
  }
  assert.equal(res.counts.kept, 10);
  const line = brandingSummary(res.photos, Object.keys(res.photos));
  assert.equal(line, "10 photos show the same logo where it can't be cropped off without losing too much of the photo, so they go on as the website shows them.");
  assert.doesNotMatch(line, /cropped (the|a) |removed|free of/i);
  assert.equal(photoNote(res.photos.p1), 'Logo still inside');
});

test('fewer than MIN_PHOTOS distinct photos are not checked; repeats count once', () => {
  const three = gallery(3, band);
  let res = findBranding(three);
  for (const e of Object.values(res.photos)) assert.deepEqual([e.status, e.reason, e.crop], ['unchecked', 'too-few', null]);
  // three photos and three exact repeats are still three photos
  const repeats = three.map((p, i) => ({ ...p, id: `copy${i}` }));
  res = findBranding([...three, ...repeats]);
  for (const e of Object.values(res.photos)) assert.deepEqual([e.status, e.reason], ['unchecked', 'too-few']);
  assert.equal(res.counts.unchecked, 6);
  const line = brandingSummary(res.photos, Object.keys(res.photos));
  assert.equal(line, 'Not checked for dealer branding (fewer than 4 different photos the same size): they go on as the website shows them.');
  assert.equal(photoNote(res.photos.p1), 'Not checked: too few photos this size');
});

test('small and broken samples are reported, not checked', () => {
  const g = gallery(6, band);
  const res = findBranding([
    ...g,
    { id: 'tiny', width: 1, height: 1, w: 0, h: 0, rgba: null },
    { id: 'broken', width: 1024, height: 768, w: 256, h: 192, rgba: new Uint8ClampedArray(10) },
    { id: 'wrongsize', width: 1024, height: 768, w: 128, h: 96, rgba: new Uint8ClampedArray(128 * 96 * 4) },
    { id: 'fraction', width: 1024.5, height: 768, w: 256, h: 192, rgba: g[0].rgba },
  ]);
  assert.deepEqual([res.photos.tiny.status, res.photos.tiny.reason, res.photos.tiny.width], ['unchecked', 'too-small', 1]);
  assert.deepEqual([res.photos.fraction.status, res.photos.fraction.reason], ['unchecked', 'too-small']);
  assert.deepEqual([res.photos.broken.status, res.photos.broken.reason], ['unchecked', 'decode']);
  assert.deepEqual([res.photos.wrongsize.status, res.photos.wrongsize.reason], ['unchecked', 'decode']);
  assert.equal(res.photos.p1.status, 'cropped');
  assert.equal(photoNote(res.photos.tiny), 'Not checked: too small');
  assert.equal(photoNote(res.photos.broken), "Not checked: couldn't be read");
});

test('photos that are all nearly the same are too alike to tell', () => {
  const base = photo(77);
  const r = rng(5);
  const g = Array.from({ length: 8 }, (_, i) => {
    const px = new Uint8ClampedArray(base);
    // the same picture with a different 64x48 patch each time: not a repeat
    // (more than 1.5% of it differs) but more than half of it never changes
    const x0 = (i % 4) * 64;
    const y0 = (i >> 2) * 96 + 24;
    for (let y = y0; y < y0 + 48; y++) for (let x = x0; x < x0 + 64; x++) px[(y * 256 + x) * 4] = r() * 255;
    return sample(`s${i}`, px);
  });
  const res = findBranding(g);
  for (const e of Object.values(res.photos)) assert.deepEqual([e.status, e.reason, e.crop], ['unchecked', 'too-alike', null]);
  assert.match(brandingSummary(res.photos, Object.keys(res.photos)), /too alike to tell a logo from the picture/);
  assert.equal(photoNote(res.photos.s0), 'Not checked: photos too alike');
});

test('photos of different sizes are checked in their own groups', () => {
  const a = gallery(6, band, { seed: 8 });
  const b = Array.from({ length: 3 }, (_, i) => sample(`q${i}`, photo(900 + i, 256, 144), 1024, 576, 256, 144));
  const res = findBranding([...a, ...b]);
  assert.equal(res.photos.p1.status, 'cropped');
  for (const id of ['q0', 'q1', 'q2']) assert.deepEqual([res.photos[id].status, res.photos[id].reason], ['unchecked', 'too-few']);
  assert.equal(brandingSummary(res.photos, Object.keys(res.photos)), 'Cropped the same logo band off the bottom of 6 of 9 photos. 3 photos were not checked (fewer than 4 different photos the same size) and go on as the website shows them. Check each one; Use original puts a photo back as the website shows it.');
});

// Other cars' covers from the same website, each with the banner over a different photo.
const lotOf = (n, overlay, { seed = 5000, w = 256, h = 192, width = 1024, height = 768 } = {}) => Array.from({ length: n }, (_, k) => {
  const px = photo(seed + k, w, h);
  if (overlay) paint(px, w, overlay);
  return { key: `CAR${k}`, ...lotSample(sample('x', px, width, height, w, h)) };
});

test('a cover-only banner is found through other cars’ covers', () => {
  const g = gallery(8, null, { seed: 9 });
  paint(g[0].rgba, 256, banner);
  const res = findBranding(g, { lot: lotOf(4, banner) });
  assert.equal(res.photos.p1.status, 'cropped');
  assert.deepEqual(res.photos.p1.sides, ['top']);
  assert.ok(res.photos.p1.crop.y >= 30 * 4, JSON.stringify(res.photos.p1.crop));
  assertHonestCrop(res.photos.p1, banner);
  for (const id of ['p2', 'p5', 'p8']) assert.equal(res.photos[id].status, 'none');
  // without the lot the cover's banner is not seen (it is on one photo only)
  assert.equal(findBranding(g).photos.p1.status, 'none');
});

test('a band a few rows deeper on the covers than on the other photos is cut to its full depth on the cover', () => {
  // every photo has the bottom band; the website's covers also carry a yellow strip just over it
  for (const extra of [1, 2, 3, 4, 5]) {
    const strip = (x, y) => (y >= 165 - extra && y < 165 ? [255, 200, 0] : null);
    const coverOverlay = (x, y) => strip(x, y) || band(x, y);
    const g = gallery(8, band, { seed: 11 });
    paint(g[0].rgba, 256, coverOverlay);
    const res = findBranding(g, { lot: lotOf(6, coverOverlay, { seed: 7100 }) });
    const cover = res.photos.p1;
    assert.equal(cover.status, 'cropped', `strip of ${extra} rows`);
    assert.equal(cover.left, null);
    assertHonestCrop(cover, coverOverlay, `strip of ${extra} rows:`);
    for (const id of ['p2', 'p5', 'p8']) assertHonestCrop(res.photos[id], band, `${id}, strip of ${extra} rows:`);
  }
});

test('lot samples of another size, or repeats of this cover, are not counted', () => {
  const g = gallery(8, null, { seed: 10 });
  paint(g[0].rgba, 256, banner);
  const cover = lotSample(g[0]);
  const other = lotOf(4, banner, { seed: 6000, w: 256, h: 144, width: 1024, height: 576 });
  const repeats = Array.from({ length: 4 }, (_, k) => ({ key: `r${k}`, ...cover }));
  const res = findBranding(g, { lot: [...other, ...repeats] });
  assert.equal(res.photos.p1.status, 'none');
});

test('the summary counts only the photos asked about', () => {
  const res = findBranding(gallery(12, band, { skip: [10, 11] }));
  assert.match(brandingSummary(res.photos, ['p1', 'p2', 'p3', 'p11']), /^Cropped the same logo band off the bottom of 3 of 4 photos\./);
  assert.equal(brandingSummary(res.photos, []), '');
  assert.equal(brandingSummary({}, []), '');
  assert.equal(brandingSummary(null, ['p1']), '');
});

// A see-through (30%) white ring and word laid over the photo.
function translucent(px, w, cx, cy) {
  const h = px.length / 4 / w;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const ring = d >= 22 && d <= 27;
      const bar = y >= cy + 34 && y < cy + 42 && x >= cx - 40 && x < cx + 40 && (x >> 2) % 2 === 0;
      if (!ring && !bar) continue;
      const o = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) px[o + k] = px[o + k] * 0.7 + 255 * 0.3;
    }
  }
  return px;
}

test('see-through marks are not looked for, and the wording claims nothing about them', () => {
  const g = gallery(12, null, { seed: 21 });
  for (const p of g) translucent(p.rgba, 256, 128, 80);
  const res = findBranding(g);
  for (const e of Object.values(res.photos)) assert.deepEqual([e.status, e.crop, e.left], ['none', null, null]);
  const line = brandingSummary(res.photos, Object.keys(res.photos));
  assert.match(line, /^Lot Current found no logo band, frame or corner logo repeating across these photos/);
  assert.doesNotMatch(line, /free of|no (dealer )?branding|no logos?\b(?! band)|clean/i);
});

// A see-through navy band over rows 165 and down (the photo shows through at
// 1 - alpha), with opaque white lettering of one colour in it, and maybe a
// two-colour logo at its right end.
function tintedBand(px, w, alpha, { logo = false } = {}) {
  const h = px.length / 4 / w;
  for (let y = 165; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const text = y >= 172 && y < 184 && (x >> 2) % 3 === 0 && x > 20 && x < 200;
      if (logo && x > 212 && x < 250 && y > 167 && y < 189) {
        const red = ((x >> 1) + (y >> 1)) % 2;
        px[o] = red ? 200 : 250;
        px[o + 1] = red ? 20 : 250;
        px[o + 2] = red ? 30 : 250;
      } else if (text) {
        px[o] = px[o + 1] = px[o + 2] = 250;
      } else {
        px[o] = px[o] * (1 - alpha) + 18 * alpha;
        px[o + 1] = px[o + 1] * (1 - alpha) + 30 * alpha;
        px[o + 2] = px[o + 2] * (1 - alpha) + 52 * alpha;
      }
    }
  }
  return px;
}
const tintRows = (x, y) => y >= 165;

test('a see-through band over a calm ground is cut at its own edge, not past it into the ground or short of it', () => {
  // six photos: a ground of one brightness per photo runs from row 140 down
  // under a 70% navy band (rows 165 and down) with white lettering. Past the
  // band the ground varies about as little as the band itself, so the band's
  // edge can't be told by how much its lines vary (the first look runs on
  // into the ground, 30 rows past the band); each photo still steps in
  // brightness at row 165 (stepIn).
  const r = rng(26);
  const lettering = (x, y) => y >= 172 && y < 184 && (x >> 2) % 3 === 0 && x > 20 && x < 200;
  const g = Array.from({ length: 6 }, (_, i) => {
    const px = photo(2000 + i);
    const grey = 60 + r() * 120;
    for (let y = 140; y < 192; y++) {
      for (let x = 0; x < 256; x++) {
        const o = (y * 256 + x) * 4;
        const t = y >= 165 ? (r() - 0.5) * 60 : (r() - 0.5) * 4;
        for (let k = 0; k < 3; k++) {
          px[o + k] = grey + t;
          if (y >= 165) px[o + k] = lettering(x, y) ? 250 : px[o + k] * 0.3 + [18, 30, 52][k] * 0.7;
        }
      }
    }
    return sample(`p${i + 1}`, px);
  });
  const res = findBranding(g);
  // two of the six are not matched to the band and go as the website shows
  // them (they were not before this edge search either)
  assert.ok(res.counts.cropped >= 4, JSON.stringify(res.counts));
  for (const e of Object.values(res.photos)) {
    if (e.status === 'none') continue;
    assert.deepEqual(e.crop, { x: 0, y: 0, w: 1024, h: 652 }, JSON.stringify(e.crop));
    assertHonestCrop(e, (x, y) => (y >= 165 ? [0, 0, 0] : null));
    assert.equal(photoNote(e), 'Cropped: logo band off the bottom');
  }
});

test('a see-through band with lettering of one colour is cut off whole', () => {
  // the lettering has no steady neighbour of another colour (the band around
  // it changes with each photo): it is told by how it stands out from the band
  for (const seed of [1, 2, 4, 5]) {
    const g = gallery(12, null, { seed });
    for (const p of g) tintedBand(p.rgba, 256, 0.6);
    const res = findBranding(g);
    assert.equal(res.counts.cropped, 12, `seed ${seed}: ${JSON.stringify(res.counts)}`);
    for (const e of Object.values(res.photos)) {
      assert.equal(e.left, null);
      assertHonestCrop(e, tintRows, `seed ${seed}:`);
      assert.equal(photoNote(e), 'Cropped: logo band off the bottom');
    }
  }
});

test('photos with a bright bottom and no band over it are not cropped', () => {
  // the same white bars, painted into the photos' own changing bottom with no band
  for (const seed of [1, 2, 4, 5]) {
    const g = gallery(12, null, { seed });
    for (const p of g) paint(p.rgba, 256, (x, y) => (y >= 172 && y < 184 && (x >> 2) % 3 === 0 && x > 20 && x < 200 ? null : y >= 186 ? [250, 250, 250] : null));
    const res = findBranding(g);
    for (const e of Object.values(res.photos)) assert.equal(e.status, 'none', `seed ${seed}`);
  }
});

test('a logo in a light see-through band takes the band with it, not only the rows the logo covers', () => {
  // too light for the band to be found on its own: the logo at its end is
  // found, and stepping around it alone would leave the rest of the band in
  for (const alpha of [0.4, 0.5, 0.6]) {
    for (const seed of [1, 2, 3, 6, 9, 12]) {
      const g = gallery(12, null, { seed });
      for (const p of g) tintedBand(p.rgba, 256, alpha, { logo: true });
      const res = findBranding(g);
      const label = `tint ${alpha}, seed ${seed}:`;
      assert.equal(res.counts.cropped, 12, `${label} ${JSON.stringify(res.counts)}`);
      for (const e of Object.values(res.photos)) {
        assert.equal(e.left, null, label);
        assertHonestCrop(e, tintRows, label);
        assert.equal(photoNote(e), 'Cropped: logo band off the bottom', label);
      }
    }
  }
});

// A photo with a sky over its top (from a dark blue at the edge to a light
// one at the horizon, a different sky in each photo) and the badge in the
// top-left corner over it.
function skyPhoto(seed) {
  const r = rng(seed);
  const c = () => [r() * 255, r() * 255, r() * 255];
  const [a, b, d, e] = [c(), c(), c(), c()];
  const shapes = Array.from({ length: 6 }, () => ({ x: r() * 256, y: 60 + r() * 132, rad: 10 + r() * 40, col: c() }));
  const hz = 40 + r() * 30;
  const top = [40 + r() * 30, 70 + r() * 40, 120 + r() * 50];
  const low = [170 + r() * 40, 200 + r() * 30, 225 + r() * 30];
  const px = new Uint8ClampedArray(256 * 192 * 4);
  for (let y = 0; y < 192; y++) {
    for (let x = 0; x < 256; x++) {
      const o = (y * 256 + x) * 4;
      const u = x / 256;
      const v = y / 192;
      const cb = badge(x, y);
      for (let k = 0; k < 3; k++) {
        let val;
        if (y < hz) val = top[k] * (1 - y / hz) + low[k] * (y / hz);
        else {
          val = a[k] * (1 - u) * (1 - v) + b[k] * u * (1 - v) + d[k] * (1 - u) * v + e[k] * u * v;
          for (const s of shapes) if ((x - s.x) ** 2 + (y - s.y) ** 2 < s.rad ** 2) val = s.col[k];
        }
        px[o + k] = cb ? cb[k] : val + (r() - 0.5) * 6;
      }
      px[o + 3] = 255;
    }
  }
  return px;
}

test('a corner logo over a sky is stepped around: the sky is not taken for a see-through band', () => {
  // a sky varies less between photos than the rest, but it goes on past any
  // line in full, where a see-through band dims every photo by one share
  for (const seed of [3, 10]) {
    const g = Array.from({ length: 12 }, (_, i) => sample(`p${i + 1}`, skyPhoto(seed * 100 + i)));
    const res = findBranding(g);
    assert.equal(res.counts.cropped, 12, `seed ${seed}`);
    for (const e of Object.values(res.photos)) {
      assertHonestCrop(e, badge, `seed ${seed}:`);
      assert.deepEqual(e.crop, { x: 0, y: 100, w: 1024, h: 668 }, `seed ${seed}`);
      assert.equal(photoNote(e), 'Cropped: corner logo off the top', `seed ${seed}`);
    }
  }
  // over many skies: never more of the sky than the badge's own strip and a
  // line past it (a see-through "band" reaching well past the badge would
  // cut up to 30% of the photo and call the sky a logo band)
  for (let seed = 1; seed <= 12; seed++) {
    const g = Array.from({ length: 12 }, (_, i) => sample(`p${i + 1}`, skyPhoto(seed * 100 + i)));
    const res = findBranding(g);
    assert.equal(res.counts.cropped, 12, `seed ${seed}`);
    for (const e of Object.values(res.photos)) {
      assertHonestCrop(e, badge, `seed ${seed}:`);
      assert.deepEqual(e.sides, ['top'], `seed ${seed}`);
      assert.ok(e.crop.y >= 100 && e.crop.y <= 104, `seed ${seed}: crop ${JSON.stringify(e.crop)}`);
    }
  }
});

test('with a band and a see-through mark, only the band is cropped: the mark stays and is not called gone', () => {
  const tuning = { seeThrough: true }; // the spike's switch for its see-through detector: gone, so it changes nothing
  const g = gallery(12, band, { seed: 22 });
  for (const p of g) translucent(p.rgba, 256, 128, 80);
  const res = findBranding(g, { tuning });
  const e = res.photos.p3;
  assert.deepEqual([e.status, e.left, e.sides], ['cropped', null, ['bottom']]);
  // the crop is the band's cut only: the see-through ring (rows 53 to 122) is still in it
  assert.ok(e.crop.y === 0 && e.crop.y + e.crop.h > 122 * 4, JSON.stringify(e.crop));
  assert.equal(photoNote(e), 'Cropped: logo band off the bottom');
  assert.ok(!('seeThrough' in res.counts));
});

test('a backdrop that never changes is not taken for an overlay', () => {
  // the same backdrop in every photo (exposure varies a little), a different
  // car-like shape in front of it each time: the backdrop's edges stay put
  const backdrop = photo(4242);
  const r = rng(99);
  const g = Array.from({ length: 12 }, (_, i) => {
    const gain = 0.9 + r() * 0.2;
    const px = new Uint8ClampedArray(backdrop.length);
    for (let p = 0; p < px.length; p += 4) for (let k = 0; k < 3; k++) px[p + k] = backdrop[p + k] * gain + (r() - 0.5) * 6;
    for (let p = 3; p < px.length; p += 4) px[p] = 255;
    const car = photo(7000 + i);
    for (let y = 70; y < 170; y++) for (let x = 30; x < 226; x++) {
      const o = (y * 256 + x) * 4;
      px[o] = car[o];
      px[o + 1] = car[o + 1];
      px[o + 2] = car[o + 2];
    }
    return sample(`b${i}`, px);
  });
  const res = findBranding(g);
  for (const e of Object.values(res.photos)) {
    assert.notEqual(e.status, 'cropped');
    assert.notEqual(e.status, 'kept');
  }
});

test('a crop reaches the far edges of a photo whose size the check grid does not divide', () => {
  // 667x445 is checked at 256x171, and (445 / 171) * 171 is a hair under 445 in floating point
  for (const [width, height] of [[667, 445], [445, 667], [1000, 667], [1023, 682]]) {
    const { w, h } = checkSize(width, height);
    const g = Array.from({ length: 10 }, (_, i) => sample(`p${i + 1}`, paint(photo(700 + i, w, h), w, topBar), width, height, w, h));
    const res = findBranding(g);
    for (const e of Object.values(res.photos)) {
      assert.equal(e.status, 'cropped', `${width}x${height}`);
      assert.deepEqual(e.sides, ['top'], `${width}x${height}: only the top had a band (${JSON.stringify(e.crop)})`);
      assert.deepEqual([e.crop.x, e.crop.x + e.crop.w, e.crop.y + e.crop.h], [0, width, height], `${width}x${height}: ${JSON.stringify(e.crop)}`);
      assert.equal(photoNote(e), 'Cropped: logo band off the top');
    }
    assert.match(brandingSummary(res.photos, Object.keys(res.photos)), /^Cropped the same logo band off the top of 10 of 10 photos\./);
  }
});

test('crops are always integer rectangles inside the photo', () => {
  for (const ov of [band, badge, banner, topAndBottom, frame]) {
    const res = findBranding(gallery(8, ov, { seed: 12 }));
    for (const e of Object.values(res.photos)) {
      if (!e.crop) continue;
      const { x, y, w, h } = e.crop;
      assert.ok([x, y, w, h].every(Number.isInteger));
      assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= e.width && y + h <= e.height, JSON.stringify(e.crop));
    }
  }
});

// ---------- the contract's floors and shapes ----------

test('TUNING is frozen, keeps at least 60% of a photo, takes bands of at most 30% of a side, and has no see-through switch', () => {
  assert.ok(Object.isFrozen(TUNING));
  assert.equal(TUNING.keepArea, 0.6);
  assert.equal(TUNING.maxBand, 0.3);
  assert.deepEqual(Object.keys(TUNING).filter((k) => /^see/.test(k)), []);
});

test('every entry has the contract\'s shape', () => {
  const res = findBranding([...gallery(6, band), { id: 'gone', reason: 'download' }]);
  const keys = ['status', 'crop', 'width', 'height', 'sides', 'bands', 'markSides', 'left', 'marks', 'reason'].sort();
  for (const e of Object.values(res.photos)) assert.deepEqual(Object.keys(e).sort(), keys);
  assert.deepEqual(Object.keys(res).sort(), ['counts', 'photos']);
  assert.deepEqual(res.counts, { cropped: 6, kept: 0, none: 0, unchecked: 1, inside: 0 });
});

test('three photos are too few; a tiny photo is too small; nothing is cropped', () => {
  const res = findBranding(gallery(3, band, { seed: 30 }));
  assert.deepEqual(Object.values(res.photos).map((e) => e.reason), ['too-few', 'too-few', 'too-few']);
  const tiny = findBranding(Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, width: 199, height: 150, w: 199, h: 150, rgba: new Uint8ClampedArray(199 * 150 * 4) })));
  assert.deepEqual(Object.values(tiny.photos).map((e) => [e.status, e.reason, e.crop]), Array(6).fill(['unchecked', 'too-small', null]));
  assert.equal(brandingSummary(tiny.photos, Object.keys(tiny.photos)), 'Not checked for dealer branding (too small to tell a logo from the picture): they go on as the website shows them.');
});

test('identical photos (a placeholder, one photo repeated) are too alike: nothing is cropped', () => {
  const one = paint(photo(4040), 256, band);
  const res = findBranding(Array.from({ length: 8 }, (_, i) => sample(`same${i}`, new Uint8ClampedArray(one))));
  for (const e of Object.values(res.photos)) assert.deepEqual([e.status, e.reason, e.crop], ['unchecked', 'too-alike', null]);
  assert.equal(res.counts.cropped, 0);
});

test('top and bottom bands are both cropped off', () => {
  const res = findBranding(gallery(10, topAndBottom, { seed: 31 }));
  for (const e of Object.values(res.photos)) {
    assert.equal(e.status, 'cropped');
    assert.deepEqual(e.bands, ['top', 'bottom']);
    assert.deepEqual(e.sides, ['top', 'bottom']);
    assert.ok(e.crop.y >= 14 * 4 && e.crop.y + e.crop.h <= 165 * 4, JSON.stringify(e.crop));
    assertHonestCrop(e, topAndBottom);
  }
  assert.match(brandingSummary(res.photos, Object.keys(res.photos)), /^Cropped the same logo bands off the top and the bottom of 10 of 10 photos\./);
  assert.equal(photoNote(res.photos.p1), 'Cropped: logo bands off the top and the bottom');
});

test('a frame is cropped off all four edges', () => {
  const res = findBranding(gallery(10, frame, { seed: 32 }));
  for (const e of Object.values(res.photos)) {
    assert.equal(e.status, 'cropped');
    assert.deepEqual(e.bands, ['top', 'right', 'bottom', 'left']);
    assert.deepEqual(e.sides, ['top', 'right', 'bottom', 'left']);
    assertHonestCrop(e, frame);
  }
  assert.match(brandingSummary(res.photos, Object.keys(res.photos)), /^Cropped the same frame off all four edges of 10 of 10 photos\./);
  assert.equal(photoNote(res.photos.p1, { original: true }), 'Original: frame left on');
});

test('a band deeper than 30% of its side is not taken for a band', () => {
  // a lettered band from row `top` down; 57 rows is 30% of 192
  const bandFrom = (top) => (x, y) => (y < top ? null : y >= top + 20 && y < top + 30 && (x >> 2) % 3 === 0 && x > 20 && x < 200 ? [250, 250, 250] : [18, 30, 52]);
  const deep = findBranding(gallery(10, bandFrom(130), { seed: 33 })); // 62 rows, 32%
  for (const e of Object.values(deep.photos)) {
    assert.notEqual(e.status, 'cropped');
    assert.equal(e.crop, null);
  }
  const fits = findBranding(gallery(10, bandFrom(139), { seed: 33 })); // 53 rows, 28%
  for (const e of Object.values(fits.photos)) {
    assert.equal(e.status, 'cropped');
    assertHonestCrop(e, bandFrom(139));
  }
});

test('a crop never keeps less than 60% of the photo', () => {
  // a 12% band on every edge: each fits, but what is left (under 58%) does not
  const box = (x, y) => {
    if (x >= 31 && x < 225 && y >= 23 && y < 169) return null;
    return (y >> 2) % 3 === 0 && (x >> 2) % 2 === 0 ? [250, 250, 250] : [90, 10, 120];
  };
  const res = findBranding(gallery(10, box, { seed: 34 }));
  for (const e of Object.values(res.photos)) {
    assert.deepEqual([e.status, e.left, e.crop], ['kept', 'too-much', null], JSON.stringify(e));
    // the frame along the edges is what stays, not a logo in the middle
    assert.equal(photoNote(e), 'Frame left on: cropping it off would cut too much of the photo');
  }
  assert.match(brandingSummary(res.photos, Object.keys(res.photos)), /can't be cropped off without losing too much of the photo/);
  // keepArea is what decides: the same gallery with the floor lowered is cropped
  const low = findBranding(gallery(10, box, { seed: 34 }), { tuning: { keepArea: 0.5 } });
  for (const e of Object.values(low.photos)) assert.equal(e.status, 'cropped');
});

test('a band with an opaque logo still inside: the band is cropped and the logo is reported as still inside', () => {
  const both = (x, y) => band(x, y) || centre(x, y + 40); // the logo at rows 70 to 100
  const res = findBranding(gallery(10, both, { seed: 35 }));
  for (const e of Object.values(res.photos)) {
    assert.equal(e.status, 'cropped');
    assert.equal(e.left, 'inside');
    assert.deepEqual(e.sides, ['bottom']);
  }
  assert.equal(res.counts.inside, 10);
  assert.match(brandingSummary(res.photos, Object.keys(res.photos)), /A logo is still inside all of them\./);
  assert.equal(photoNote(res.photos.p1), 'Cropped: logo band off the bottom; logo still inside');
});

test('the lot needs this cover and three other cars: a cover-only banner with exactly three others is cropped', () => {
  const g = gallery(6, null, { seed: 36 });
  paint(g[0].rgba, 256, banner);
  const res = findBranding(g, { lot: lotOf(3, banner, { seed: 6100 }) });
  assert.equal(res.photos.p1.status, 'cropped');
  assertHonestCrop(res.photos.p1, banner);
  for (const id of ['p2', 'p3', 'p6']) assert.equal(res.photos[id].status, 'none');
  // two others are not enough: the banner is not seen
  assert.equal(findBranding(g, { lot: lotOf(2, banner, { seed: 6100 }) }).photos.p1.status, 'none');
  // other cars without the banner: nothing to find
  assert.equal(findBranding(g, { lot: lotOf(6, null, { seed: 6100 }) }).photos.p1.status, 'none');
});

test('the cover option names the photo compared with the other cars\' covers', () => {
  const g = gallery(6, null, { seed: 37 });
  paint(g[2].rgba, 256, banner);
  // three other cars: the check needs this car's cover to carry the banner too
  const lot = lotOf(3, banner, { seed: 6200 });
  assert.equal(findBranding(g, { lot }).photos.p3.status, 'none', 'by default the first photo is the cover');
  const res = findBranding(g, { lot, cover: 'p3' });
  assert.equal(res.photos.p3.status, 'cropped');
  assert.equal(res.photos.p1.status, 'none');
  assert.equal(findBranding(g, { lot, cover: 'nope' }).photos.p3.status, 'none');
});

test('lot entries of another size, or malformed, are ignored', () => {
  const g = gallery(6, null, { seed: 38 });
  paint(g[0].rgba, 256, banner);
  const good = lotOf(3, banner, { seed: 6300 });
  // two good covers and the third one wrong in some way: too few to tell
  for (const third of [{ ...good[2], width: 1600 }, { ...good[2], height: 600 }, { ...good[2], rgb: good[2].rgb.subarray(0, 100) }, { ...good[2], w: 64 }, { ...good[2], rgb: [...good[2].rgb] }, null]) {
    assert.equal(findBranding(g, { lot: [good[0], good[1], third] }).photos.p1.status, 'none', JSON.stringify(third && { width: third.width, height: third.height, w: third.w }));
  }
  assert.equal(findBranding(g, { lot: good }).photos.p1.status, 'cropped');
});

test('photos the caller could not read come back unchecked with its reason, and don\'t count as photos', () => {
  const g = gallery(3, band, { seed: 39 });
  const unread = ['format', 'decode', 'download', 'server', 'slow'].map((reason, i) => ({ id: `u${i}`, reason }));
  const res = findBranding([...g, ...unread, { id: 'odd', reason: 'whatever' }, { id: 'u0', reason: 'slow' }]);
  for (const [i, reason] of ['format', 'decode', 'download', 'server', 'slow'].entries()) {
    assert.deepEqual([res.photos[`u${i}`].status, res.photos[`u${i}`].reason, res.photos[`u${i}`].crop], ['unchecked', reason, null]);
  }
  assert.equal(res.photos.odd.reason, 'decode', 'an unknown reason is a photo that could not be read');
  assert.equal(res.photos.u0.reason, 'format', 'the first photo of an id wins');
  for (const id of ['p1', 'p2', 'p3']) assert.equal(res.photos[id].reason, 'too-few');
  assert.equal(photoNote(res.photos.u0), "Not checked: format can't be read");
  assert.equal(photoNote(res.photos.u2), "Not checked: couldn't be downloaded");
  assert.equal(photoNote(res.photos.u3), 'Not checked: photo server not allowed');
  assert.equal(photoNote(res.photos.u4), 'Not checked: took too long');
  assert.equal(brandingSummary(res.photos, ['u2', 'u4']), "Not checked for dealer branding (couldn't be downloaded; took too long to download): they go on as the website shows them.");
  assert.deepEqual(findBranding('nope'), { photos: {}, counts: { cropped: 0, kept: 0, none: 0, unchecked: 0, inside: 0 } });
});

test('more than MAX_CHECK_PHOTOS photos of one size: the first 40 are the evidence, and every one is still matched', () => {
  const res = findBranding(gallery(44, band, { seed: 40, skip: [42] }));
  assert.equal(res.counts.cropped, 43);
  assert.equal(res.photos.p43.status, 'none');
  assert.equal(res.photos.p44.status, 'cropped');
});

// ---------- the cover samples kept per website ----------

const tinyLot = (seed, w = 4, h = 3) => {
  const r = rng(seed);
  return { width: 1024, height: 768, w, h, rgb: Uint8Array.from({ length: w * h * 3 }, () => Math.floor(r() * 256)) };
};

test('withCover keeps the newest cover first, one per VIN, at most COVER_SAMPLE_CARS', () => {
  let stored;
  for (let i = 0; i < 10; i++) stored = withCover(stored, { vin: `VIN${i}`, at: `2026-10-0${(i % 9) + 1}T10:00:00.000Z`, sample: tinyLot(i) });
  assert.equal(stored.version, 1);
  assert.equal(stored.cars.length, COVER_SAMPLE_CARS);
  assert.deepEqual(stored.cars.map((c) => c.vin), ['VIN9', 'VIN8', 'VIN7', 'VIN6', 'VIN5', 'VIN4', 'VIN3', 'VIN2']);
  assert.deepEqual(Object.keys(stored.cars[0]).sort(), ['at', 'data', 'h', 'height', 'vin', 'w', 'width']);
  // the same car again (any case) moves to the front and is not kept twice
  stored = withCover(stored, { vin: 'vin5', at: '2026-10-07T10:00:00.000Z', sample: tinyLot(55) });
  assert.deepEqual(stored.cars.map((c) => c.vin.toUpperCase()), ['VIN5', 'VIN9', 'VIN8', 'VIN7', 'VIN6', 'VIN4', 'VIN3', 'VIN2']);
  // the data round-trips through otherCovers exactly
  const back = otherCovers(stored, 'VIN9').find((c) => c.key === 'vin5');
  assert.deepEqual([...back.rgb], [...tinyLot(55).rgb]);
  assert.deepEqual([back.width, back.height, back.w, back.h], [1024, 768, 4, 3]);
  // JSON-safe: it is stored in chrome.storage.local
  assert.deepEqual(JSON.parse(JSON.stringify(stored)), stored);
});

test('withCover takes a check sample or its lotSample, and drops a malformed stored value', () => {
  const check = gallery(1, null)[0];
  const a = withCover(null, { vin: 'A', at: '2026-10-07T10:00:00.000Z', sample: check });
  const b = withCover(null, { vin: 'A', at: '2026-10-07T10:00:00.000Z', sample: lotSample(check) });
  assert.deepEqual(a, b);
  assert.deepEqual([a.cars[0].w, a.cars[0].h], [128, 96]);
  for (const bad of [null, undefined, 'x', 42, [], { version: 2, cars: [] }, { version: 1, cars: 'no' }, { version: 1 }]) {
    assert.deepEqual(withCover(bad, { vin: 'B', at: '2026-10-07T10:00:00.000Z', sample: tinyLot(1) }).cars.map((c) => c.vin), ['B']);
  }
  // malformed cars inside a good value are dropped too
  const mixed = { version: 1, cars: [{ vin: 'X', at: 't', width: 1024, height: 768, w: 4, h: 3, data: '@@@@' }, { vin: 'Y', at: 't', width: 1024, height: 768, w: 4, h: 3, data: 'AAAA' }, ...withCover(null, { vin: 'Z', at: 't', sample: tinyLot(2) }).cars] };
  assert.deepEqual(withCover(mixed, { vin: 'C', at: 't', sample: tinyLot(3) }).cars.map((c) => c.vin), ['C', 'Z']);
  // nothing usable to add: the stored cars stay as they were
  const kept = withCover(null, { vin: 'Z', at: 't', sample: tinyLot(2) });
  assert.deepEqual(withCover(kept, { vin: '', at: 't', sample: tinyLot(4) }), kept);
  assert.deepEqual(withCover(kept, { vin: 'Q', at: 't', sample: null }), kept);
  assert.deepEqual(withCover(kept, { vin: 'Q', at: 't', sample: { ...tinyLot(4), w: 200, rgb: new Uint8Array(200 * 3 * 3) } }), kept, 'never more than LOT_LONG_SIDE across');
  assert.deepEqual(withCover(kept, {}), kept);
  // a Date is stored as an ISO string
  assert.equal(withCover(null, { vin: 'D', at: new Date(Date.UTC(2026, 9, 7)), sample: tinyLot(5) }).cars[0].at, '2026-10-07T00:00:00.000Z');
});

test('otherCovers gives every car but this one, newest first, skipping malformed entries', () => {
  let stored = null;
  for (const v of ['A', 'B', 'C']) stored = withCover(stored, { vin: v, at: 't', sample: tinyLot(v.charCodeAt(0)) });
  assert.deepEqual(otherCovers(stored, 'B').map((c) => c.key), ['C', 'A']);
  assert.deepEqual(otherCovers(stored, 'b').map((c) => c.key), ['C', 'A'], 'VINs compare without case');
  assert.deepEqual(otherCovers(stored, null).map((c) => c.key), ['C', 'B', 'A']);
  for (const c of otherCovers(stored, 'B')) assert.ok(c.rgb instanceof Uint8Array && c.rgb.length === c.w * c.h * 3);
  const good = stored.cars[0];
  const broken = { version: 1, cars: [
    { ...good, vin: 'short', data: good.data.slice(0, 8) },
    { ...good, vin: 'notb64', data: '!!!!' + good.data.slice(4) },
    { ...good, vin: 'nosize', w: undefined },
    { ...good, vin: 'bigger', w: 5 },
    null, 'x',
    { ...good, vin: 'fine' },
  ] };
  assert.deepEqual(otherCovers(broken, 'C').map((c) => c.key), ['fine']);
  assert.deepEqual(otherCovers(undefined, 'C'), []);
  assert.deepEqual(otherCovers({ version: 9, cars: stored.cars }, 'C'), []);
});

test('stored covers work as the lot: a cover-only banner is found from the other cars kept', () => {
  let stored = null;
  for (const [k, car] of lotOf(4, banner, { seed: 6400 }).entries()) stored = withCover(stored, { vin: `OTHER${k}`, at: 't', sample: car });
  const g = gallery(6, null, { seed: 41 });
  paint(g[0].rgba, 256, banner);
  stored = withCover(stored, { vin: 'THIS', at: 't', sample: g[0] });
  const lot = otherCovers(stored, 'THIS');
  assert.equal(lot.length, 4);
  assert.equal(findBranding(g, { lot }).photos.p1.status, 'cropped');
});

// ---------- what is sent ----------

const cropped = { status: 'cropped', crop: { x: 0, y: 0, w: 1024, h: 656 }, width: 1024, height: 768, sides: ['bottom'], bands: ['bottom'], left: null, marks: 0, reason: null, sha: 'f00d', type: 'image/jpeg' };
const URL_A = 'https://img.example-dealer.test/a.jpg';

test('cropPlan gives the crop of a cropped photo, unless the person set it back', () => {
  assert.deepEqual(cropPlan(cropped, { url: URL_A }), { x: 0, y: 0, w: 1024, h: 656, width: 1024, height: 768, sha: 'f00d' });
  assert.deepEqual(cropPlan(cropped, { url: URL_A, originals: null }), cropPlan(cropped, { url: URL_A }));
  assert.equal(cropPlan(cropped, { url: URL_A, originals: [URL_A] }), null);
  assert.equal(cropPlan(cropped, { url: URL_A, originals: new Set([URL_A]) }), null);
  assert.ok(cropPlan(cropped, { url: URL_A, originals: ['https://img.example-dealer.test/b.jpg'] }));
  for (const status of ['kept', 'none', 'unchecked']) assert.equal(cropPlan({ ...cropped, status }, { url: URL_A }), null);
  assert.equal(cropPlan(null, { url: URL_A }), null);
  // a crop that doesn't fit its photo is never sent
  for (const crop of [{ x: 0, y: 0, w: 1025, h: 656 }, { x: -1, y: 0, w: 100, h: 100 }, { x: 0.5, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 0, h: 10 }, null]) {
    assert.equal(cropPlan({ ...cropped, crop }, { url: URL_A }), null, JSON.stringify(crop));
  }
  assert.equal(cropPlan({ ...cropped, sha: undefined }, { url: URL_A }).sha, null);
});

test('matchesCheck: only the bytes that were checked are cropped', () => {
  const plan = cropPlan(cropped, { url: URL_A });
  assert.equal(matchesCheck(plan, { width: 1024, height: 768, sha: 'f00d' }), true);
  assert.equal(matchesCheck(plan, { width: 1024, height: 768, sha: 'beef' }), false);
  assert.equal(matchesCheck(plan, { width: 1280, height: 768, sha: 'f00d' }), false);
  assert.equal(matchesCheck(plan, { width: 1024, height: 960, sha: 'f00d' }), false);
  assert.equal(matchesCheck(plan, {}), false);
  assert.equal(matchesCheck(null, { width: 1024, height: 768, sha: 'f00d' }), false);
  assert.equal(matchesCheck({ ...plan, sha: null }, { width: 1024, height: 768, sha: null }), false, 'no fingerprint, no crop');
});

test('insetOf shows the crop in the thumbnail, never more than is sent', () => {
  assert.equal(insetOf(cropped), 'inset(0% 0% 14.6% 0%)'); // 112 of 768 = 14.583%
  assert.equal(insetOf({ ...cropped, crop: { x: 256, y: 192, w: 512, h: 384 } }), 'inset(25% 25% 25% 25%)');
  assert.equal(insetOf({ ...cropped, crop: { x: 1, y: 0, w: 1023, h: 768 } }), 'inset(0% 0% 0% 0.1%)');
  for (const status of ['kept', 'none', 'unchecked']) assert.equal(insetOf({ ...cropped, status }), '');
  assert.equal(insetOf({ ...cropped, crop: { x: 0, y: 0, w: 2000, h: 10 } }), '');
  const r = rng(7);
  for (let i = 0; i < 2000; i++) {
    const width = 200 + Math.floor(r() * 3000);
    const height = 200 + Math.floor(r() * 3000);
    const x = Math.floor(r() * width * 0.3);
    const y = Math.floor(r() * height * 0.3);
    const w = Math.max(1, Math.floor((width - x) * (0.6 + r() * 0.4)));
    const h = Math.max(1, Math.floor((height - y) * (0.6 + r() * 0.4)));
    const m = insetOf({ status: 'cropped', crop: { x, y, w, h }, width, height }).match(/^inset\(([\d.]+)% ([\d.]+)% ([\d.]+)% ([\d.]+)%\)$/);
    assert.ok(m);
    const exact = [y / height, (width - x - w) / width, (height - y - h) / height, x / width].map((v) => v * 100);
    m.slice(1).map(Number).forEach((shown, k) => {
      assert.ok(shown >= exact[k] - 1e-9, `inset ${shown}% shows more than the crop (${exact[k]}%)`);
      assert.ok(shown < exact[k] + 0.2, `inset ${shown}% hides more than 0.2% past the crop (${exact[k]}%)`);
      assert.ok(Number.isInteger(Math.round(shown * 10)) && Math.abs(shown * 10 - Math.round(shown * 10)) < 1e-9, 'in steps of 0.1%');
    });
  }
});

test('fileNameFor gives the extension of the type sent', () => {
  assert.equal(fileNameFor('photo-03.jpg', 'image/png'), 'photo-03.png');
  assert.equal(fileNameFor('photo-03.jpg', 'image/jpeg'), 'photo-03.jpg');
  assert.equal(fileNameFor('photo-03.jpeg', 'image/jpeg'), 'photo-03.jpeg');
  assert.equal(fileNameFor('photo-03.png', 'image/jpeg'), 'photo-03.jpg');
  assert.equal(fileNameFor('STK1-photo-01.webp', 'image/webp'), 'STK1-photo-01.webp');
  assert.equal(fileNameFor('photo-01.avif', 'image/jpeg'), 'photo-01.jpg');
  assert.equal(fileNameFor('photo-04', 'image/png'), 'photo-04.png');
  assert.equal(fileNameFor('photo-05.jpg', 'IMAGE/PNG'), 'photo-05.png');
  assert.equal(fileNameFor('photo-06.jpg', 'application/octet-stream'), 'photo-06.jpg');
  assert.equal(fileNameFor('photo-07.jpg', undefined), 'photo-07.jpg');
});

// ---------- the words ----------

test('the summary says what the person set back, and what was not checked and why', () => {
  const res = findBranding([...gallery(8, band, { seed: 42 }), { id: 'gif', reason: 'format' }]);
  const ids = Object.keys(res.photos);
  assert.equal(brandingSummary(res.photos, ids, { originals: ['p2', 'p3'] }),
    "Cropped the same logo band off the bottom of 6 of 9 photos. You set 2 photos back to the website's original, with the logo band left on. 1 photo was not checked (a picture format Lot Current can't read) and goes on as the website shows it. Check each one; Use original puts a photo back as the website shows it.");
  assert.equal(brandingSummary(res.photos, ['p1', 'p2'], { originals: ['p1', 'p2'] }), "You set 2 photos back to the website's original, with the logo band left on.");
  assert.equal(photoNote(res.photos.p2, { original: true }), 'Original: logo band left on');
  assert.equal(photoNote(res.photos.p2, { original: false }), 'Cropped: logo band off the bottom');
  // a photo the website added after the check has no entry: it was not checked
  assert.equal(brandingSummary(res.photos, ['p1', 'new']), 'Cropped the same logo band off the bottom of 1 of 2 photos. 1 photo was not checked (the check ran without it) and goes on as the website shows it. Check each one; Use original puts a photo back as the website shows it.');
  // nothing found among the photos checked, some not checked
  const clean = findBranding([...gallery(6, null, { seed: 43 }), { id: 'slow', reason: 'slow' }]);
  assert.equal(brandingSummary(clean.photos, Object.keys(clean.photos)), 'Lot Current found no logo band, frame or corner logo repeating across the 6 photos checked; they go on as the website shows them. 1 photo was not checked (took too long to download) and goes on as the website shows it.');
});

test('no wording ever says a photo is free of branding, and unchecked photos are said to be not checked', () => {
  const banned = /free of|branding[- ]free|no (dealer )?branding|without (any )?branding|clean|all (the )?branding (is )?(removed|gone)|removed (all|every)|logo-free|no logos?\b(?! band)/i;
  const lines = [];
  const cases = [
    findBranding(gallery(8, null, { seed: 44 })),
    findBranding(gallery(8, band, { seed: 45 })),
    findBranding(gallery(8, badge, { seed: 46 })),
    findBranding(gallery(8, centre, { seed: 47 })),
    findBranding(gallery(3, band, { seed: 48 })),
    findBranding([...gallery(5, band, { seed: 49 }), ...['format', 'decode', 'download', 'server', 'slow'].map((reason) => ({ id: reason, reason }))]),
    findBranding([{ id: 'x', width: 10, height: 10 }]),
  ];
  for (const res of cases) {
    const ids = Object.keys(res.photos);
    for (const originals of [[], ids.slice(0, 2)]) {
      const line = brandingSummary(res.photos, ids, { originals });
      lines.push(line);
      assert.ok(line.length > 0);
      const unchecked = ids.filter((id) => res.photos[id].status === 'unchecked').length;
      if (unchecked) assert.match(line, /not checked/i, line);
      else assert.doesNotMatch(line, /not checked/i, line);
    }
    for (const e of Object.values(res.photos)) {
      for (const original of [false, true]) {
        const n = photoNote(e, { original });
        lines.push(n);
        if (e.status === 'unchecked') assert.match(n, /^Not checked: /);
      }
    }
  }
  for (const line of lines) assert.doesNotMatch(line, banned, line);
  // nothing found is said as what was looked for, never as a clean bill
  assert.match(brandingSummary(cases[0].photos, Object.keys(cases[0].photos)), /^Lot Current found no logo band, frame or corner logo repeating across/);
});
