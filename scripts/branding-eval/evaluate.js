// Scenarios and metrics for the dealer-branding check
// (extension/src/photoBranding.js, imported as it ships). Runs in Chromium.
// Every scenario builds a synthetic car gallery (gen.js), lays the made-up
// vendor overlay over the photos it names, saves them as JPEG the way a
// vendor and a CDN would, decodes them the way the side panel does, runs
// findBranding and measures each crop at full resolution against the
// overlay's known alpha.
import * as G from './gen.js';
import * as PB from '../../extension/src/photoBranding.js';

const PRICES = ['$18,995', '$24,500', '$9,850', '$31,250', '$15,400', '$27,999', '$12,750', '$21,300', '$38,900'];

// expect: 'positive' (every photo that carries an opaque overlay should be
// cropped clean), 'negative' (nothing may be cropped, kept or flagged),
// 'see' (a see-through mark inside the photo: the check does not look for
// these, so 'none' is the expected answer and counts as a miss; a crop may
// cut an edge band beside it, but a crop that leaves a see-through-only mark
// in and says nothing is a lie), 'kept' (an opaque logo inside the photo:
// reported, never cropped as clean).
export const SCENARIOS = {
  // ---- positives ----
  'bottom-band': { overlay: 'bottomBand', expect: 'positive' },
  'top-bar+bottom-band': { overlay: 'topBottom', expect: 'positive', seed: 12 },
  'frame-rounded': { overlay: 'frame', expect: 'positive', seed: 13 },
  'corner-badge': { overlay: 'cornerBadge', expect: 'positive', seed: 14 },
  'band-with-logo-tab': { overlay: 'tab', expect: 'positive', seed: 15 },
  'band-with-shadow': { overlay: 'shadowBand', expect: 'positive', seed: 16 },
  'semi-opaque-band': { overlay: 'semiBand', expect: 'positive', seed: 17 },
  'corner-tab-bottom-right': { overlay: 'cornerTab', expect: 'positive', seed: 18 },
  'bottom-band-cdn-resize': { overlay: 'bottomBand', expect: 'positive', seed: 19, cdn: { from: [1600, 1200], q1: 0.9, q2: 0.78 } },
  'bottom-band-q75': { overlay: 'bottomBand', expect: 'positive', seed: 20, jpeg: 0.75 },
  'bottom-band-16x9': { overlay: 'bottomBand', expect: 'positive', seed: 21, size: [1920, 1080] },
  'bottom-band-overcast': { overlay: 'bottomBand', expect: 'positive', seed: 22, scene: { overcast: true, extShare: 0.75 } },
  'bottom-band-studio': { overlay: 'bottomBand', expect: 'positive', seed: 23, scene: { studio: 'grey', extShare: 0.6 } },
  'one-photo-without-overlay': { overlay: 'bottomBand', without: [6], expect: 'positive', seed: 24 },
  'two-without-of-8': { overlay: 'topBottom', count: 8, without: [3, 5], expect: 'positive', seed: 25 },
  'gallery-3-band': { overlay: 'bottomBand', count: 3, expect: 'positive', seed: 26 },
  'gallery-4-band': { overlay: 'bottomBand', count: 4, expect: 'positive', seed: 27 },
  'gallery-6-band': { overlay: 'bottomBand', count: 6, expect: 'positive', seed: 28 },
  'gallery-40-frame': { overlay: 'frame', count: 40, expect: 'positive', seed: 29 },
  'mixed-sizes-band': { overlay: 'bottomBand', expect: 'positive', seed: 30, sizes: mixedSizes(20) },
  'duplicates-band': { overlay: 'bottomBand', expect: 'positive', seed: 31, dupes: dupePlan() },
  'cover-banner-lot4': { cover: 'coverBanner', lot: { count: 4, overlay: 'coverBanner', prices: true }, expect: 'positive', seed: 32 },
  'cover-banner-lot8': { cover: 'coverBanner', lot: { count: 8, overlay: 'coverBanner', prices: true }, expect: 'positive', seed: 33 },
  'cover-banner-lot3': { cover: 'coverBanner', lot: { count: 3, overlay: 'coverBanner', prices: true }, expect: 'positive', seed: 34 },
  'cover-banner-some-prices': { cover: 'coverBanner', lot: { count: 6, overlay: 'coverBanner', prices: 'some' }, expect: 'positive', seed: 35 },
  'cover-banner+band-lot6': { overlay: 'bottomBand', cover: 'coverBanner', lot: { count: 6, overlay: 'coverBanner+bottomBand', prices: true }, expect: 'positive', seed: 36 },
  'cover-banner-small-gallery': { count: 3, cover: 'coverBanner', lot: { count: 5, overlay: 'coverBanner', prices: true }, expect: 'positive', seed: 37 },
  // ---- see-through ----
  'centre-watermark': { overlay: 'watermark', expect: 'see', seed: 40 },
  'band+watermark': { overlay: 'bottomBand+watermark', expect: 'see', seed: 41 },
  // ---- negatives ----
  'neg-varied': { expect: 'negative', seed: 50 },
  'neg-varied-2': { expect: 'negative', seed: 51, scene: { extShare: 0.3 } },
  'neg-exterior-only': { expect: 'negative', seed: 52, scene: { extShare: 1 } },
  'neg-studio': { expect: 'negative', seed: 53, scene: { studio: 'grey', extShare: 0.6 } },
  'neg-studio-mostly-ext': { expect: 'negative', seed: 54, scene: { studio: 'white', extShare: 0.85 } },
  'neg-overcast': { expect: 'negative', seed: 55, scene: { overcast: true, extShare: 0.75 } },
  'neg-overcast-all-ext': { expect: 'negative', seed: 56, scene: { overcast: true, extShare: 1 } },
  'neg-duplicates': { expect: 'negative', seed: 57, dupes: dupePlan() },
  'neg-dupes-small': { expect: 'negative', seed: 58, count: 6, dupes: [[1, 0, 'exact'], [2, 0, 'resave'], [3, 0, 'exact']] },
  'neg-mixed-sizes': { expect: 'negative', seed: 59, sizes: mixedSizes(20) },
  'neg-tiny-placeholders': { expect: 'negative', seed: 60, tiny: true },
  'neg-big-placeholders': { expect: 'negative', seed: 61, placeholder: true },
  'neg-gallery-3': { expect: 'negative', seed: 62, count: 3 },
  'neg-gallery-4': { expect: 'negative', seed: 63, count: 4 },
  'neg-gallery-6': { expect: 'negative', seed: 64, count: 6 },
  'neg-gallery-4-ext': { expect: 'negative', seed: 65, count: 4, scene: { extShare: 1 } },
  'neg-gallery-4-overcast': { expect: 'negative', seed: 66, count: 4, scene: { overcast: true, extShare: 1 } },
  'neg-lot-same-spot': { expect: 'negative', seed: 67, lot: { count: 8, overlay: null, spot: 9 }, coverSpot: 9 },
  'neg-lot-varied': { expect: 'negative', seed: 68, lot: { count: 8, overlay: null } },
  'neg-lot-4-same-spot-overcast': { expect: 'negative', seed: 69, lot: { count: 3, overlay: null, spot: 4 }, coverSpot: 4, scene: { overcast: true } },
  'neg-interior-heavy': { expect: 'negative', seed: 70, scene: { extShare: 0.15 } },
  'neg-40-photos': { expect: 'negative', seed: 71, count: 40 },
  // ---- harder negatives ----
  'neg-same-spot': { expect: 'negative', seed: 72, spot: 21 },
  'neg-same-spot-all-ext': { expect: 'negative', seed: 73, spot: 22, scene: { extShare: 1 } },
  'neg-same-spot-4': { expect: 'negative', seed: 74, spot: 23, count: 4, scene: { extShare: 1 } },
  'neg-same-spot-6-overcast': { expect: 'negative', seed: 75, spot: 24, count: 6, scene: { extShare: 1, overcast: true } },
  'neg-booth-poster': { expect: 'negative', seed: 76, scene: { studio: 'poster', extShare: 0.85 } },
  'neg-booth-poster-60': { expect: 'negative', seed: 77, scene: { studio: 'poster', extShare: 0.6 } },
  'neg-booth-poster-6': { expect: 'negative', seed: 78, count: 6, scene: { studio: 'poster', extShare: 1 } },
  'neg-letterbox': { expect: 'negative', seed: 79, overlay: 'letterbox', overlayIsNotBranding: true },
  // ---- limits ----
  'weak-watermark': { overlay: 'weakWatermark', expect: 'see', seed: 80 },
  'corner-watermark': { overlay: 'cornerWatermark', expect: 'see', seed: 89 },
  'centre-logo-opaque': { overlay: 'centreLogo', expect: 'kept', seed: 81 },
  'thick-frame': { overlay: 'thickFrame', expect: 'positive', seed: 82 },
  'band-photo-counter': { overlay: 'bandCounter', counter: true, expect: 'positive', seed: 83 },
  'band-on-14-of-20': { overlay: 'bottomBand', without: [14, 15, 16, 17, 18, 19], expect: 'positive', seed: 84 },
  'bottom-band-q60': { overlay: 'bottomBand', expect: 'positive', seed: 85, jpeg: 0.6 },
  'bottom-band-2048': { overlay: 'bottomBand', expect: 'positive', seed: 86, size: [2048, 1536] },
  'corner-badge-2048': { overlay: 'cornerBadge', expect: 'positive', seed: 87, size: [2048, 1536] },
  'frame-same-spot': { overlay: 'frame', expect: 'positive', seed: 88, spot: 25, scene: { extShare: 0.6 } },
  // ---- a fixed camera (no camera movement at all) with auto exposure ----
  'neg-fixed-camera': { expect: 'negative', seed: 90, spot: 26, scene: { fixed: true, extShare: 1 } },
  'neg-fixed-camera-85': { expect: 'negative', seed: 91, spot: 27, scene: { fixed: true, extShare: 0.85 } },
  'neg-fixed-booth-poster': { expect: 'negative', seed: 92, scene: { studio: 'poster', auto: true, extShare: 0.9 } },
  'neg-fixed-booth-poster-6': { expect: 'negative', seed: 93, count: 6, scene: { studio: 'poster', auto: true, extShare: 1 } },
  'frame-fixed-camera': { overlay: 'frame', expect: 'positive', seed: 94, spot: 28, scene: { fixed: true, extShare: 0.85 } },
  'badge-fixed-booth': { overlay: 'cornerBadge', expect: 'positive', seed: 95, scene: { studio: 'poster', auto: true, extShare: 0.9 } },
  // ---- a see-through band in a small gallery (too few photos for its own test) ----
  'semi-opaque-band-6': { overlay: 'semiBand', count: 6, expect: 'positive', seed: 96 },
  'semi-opaque-band-4': { overlay: 'semiBand', count: 4, expect: 'positive', seed: 97 },
  'band-with-shadow-6': { overlay: 'shadowBand', count: 6, expect: 'positive', seed: 98 },
  'semi-opaque-band-fixed-camera': { overlay: 'semiBand', expect: 'positive', seed: 99, spot: 29, scene: { fixed: true, extShare: 0.85 } },
  // ---- a fixed camera for three photos in four: between the share values swept (0.7 to 0.8) ----
  'neg-fixed-camera-75': { expect: 'negative', seed: 100, spot: 30, scene: { fixed: true, extShare: 0.75 } },
  'neg-fixed-booth-poster-75': { expect: 'negative', seed: 101, scene: { studio: 'poster', auto: true, extShare: 0.75 } },
};

function mixedSizes(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(i % 5 === 3 ? [1024, 576] : i % 5 === 4 ? [768, 1024] : [1024, 768]);
  return out;
}

function dupePlan() {
  // [target index, source index, how]: exact repeats and re-saved copies
  return [[14, 0, 'exact'], [15, 1, 'exact'], [16, 2, 'resave'], [17, 3, 'resave'], [18, 9, 'exact'], [19, 10, 'resave']];
}

const alphaCache = new Map();
function overlayFor(kind, W, H, opt = {}) {
  const key = `${kind}:${W}x${H}:${opt.price || ''}:${opt.counter || ''}`;
  if (!alphaCache.has(key)) {
    const c = G.makeOverlay(kind, W, H, opt);
    alphaCache.set(key, { canvas: c, alpha: G.alphaOf(c) });
  }
  return alphaCache.get(key);
}

async function blobToSample(blob, quality) {
  return G.decodeSample(blob, PB.checkSize, quality);
}

// A 1x1 PNG, as the repo's e2e mock serves for every photo.
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function makePhoto(def, car, shot, r, T, W, H, kind, price, spot, counter) {
  const photo = G.renderPhoto(W, H, car, shot, r, T, { ...(def.scene || {}), spot });
  let alpha = null;
  let blob;
  if (def.cdn && kind) {
    const [W1, H1] = def.cdn.from;
    const big = G.canvas(W1, H1);
    big.getContext('2d').drawImage(photo, 0, 0, W1, H1);
    const ov = overlayFor(kind, W1, H1, { price });
    const b1 = await G.vendorPhoto(big, ov.canvas, def.cdn.q1);
    blob = await G.cdnResize(b1, W, H, def.cdn.q2);
    const key = `cdn:${kind}:${W1}x${H1}->${W}x${H}`;
    if (!alphaCache.has(key)) alphaCache.set(key, { alpha: G.resizeAlpha(ov.canvas, W, H) });
    alpha = alphaCache.get(key).alpha;
  } else if (def.cdn) {
    const [W1, H1] = def.cdn.from;
    const big = G.canvas(W1, H1);
    big.getContext('2d').drawImage(photo, 0, 0, W1, H1);
    const b1 = await G.vendorPhoto(big, null, def.cdn.q1);
    blob = await G.cdnResize(b1, W, H, def.cdn.q2);
  } else {
    const ov = kind ? overlayFor(kind, W, H, { price, counter }) : null;
    blob = await G.vendorPhoto(photo, ov && ov.canvas, def.jpeg || 0.85);
    alpha = ov ? ov.alpha : null;
  }
  return { blob, alpha, W, H, canvas: photo };
}

function metricsFor(entry, alpha, W, H) {
  const crop = entry.crop || { x: 0, y: 0, w: W, h: H };
  const m = { opaqueLeft: 0, fringeLeft: 0, maxAlphaIn: 0, strip: 0, lostClean: 0, overlayPx: 0 };
  if (!alpha) {
    m.lostClean = 1 - (crop.w * crop.h) / (W * H);
    return m;
  }
  const x1 = crop.x + crop.w;
  const y1 = crop.y + crop.h;
  let cleanOut = 0;
  const colSum = new Float64Array(crop.w);
  for (let y = 0; y < H; y++) {
    const inY = y >= crop.y && y < y1;
    let rowSum = 0;
    for (let x = 0; x < W; x++) {
      const a = alpha[y * W + x];
      if (a > 127) m.overlayPx++;
      const inside = inY && x >= crop.x && x < x1;
      if (inside) {
        if (a > 127) m.opaqueLeft++;
        else if (a > 5) m.fringeLeft++;
        if (a > m.maxAlphaIn) m.maxAlphaIn = a;
        rowSum += a;
        colSum[x - crop.x] += a;
      } else if (a <= 5) cleanOut++;
    }
    if (inY) m.strip = Math.max(m.strip, rowSum / crop.w / 255);
  }
  for (let i = 0; i < crop.w; i++) m.strip = Math.max(m.strip, colSum[i] / crop.h / 255);
  m.lostClean = cleanOut / (W * H);
  m.maxAlphaIn /= 255;
  return m;
}

export async function runScenario(name, opts = {}) {
  const base = SCENARIOS[name];
  if (!base) throw new Error('no scenario ' + name);
  const def = { count: 20, size: [1024, 768], seed: 11, ...base };
  // another draw of the same scenario: a different car, scenes and lot
  if (opts.seedOffset) {
    def.seed += opts.seedOffset * 1009;
    if (def.spot != null) def.spot += opts.seedOffset * 13;
    if (def.coverSpot != null) def.coverSpot += opts.seedOffset * 13;
    if (def.lot && def.lot.spot != null) def.lot = { ...def.lot, spot: def.lot.spot + opts.seedOffset * 13 };
    if (def.lot && def.lot.spot != null && base.coverSpot != null) def.coverSpot = def.lot.spot;
  }
  const quality = opts.quality || 'high';
  const tuning = opts.tuning || null;
  const r = G.rngOf(def.seed * 7919);
  const car = G.makeCar(r);
  const plan = G.galleryPlan(def.count, r, def.scene || {});
  const photos = [];
  const samples = [];
  const tDecode = [];
  // ---- this car's gallery ----
  for (let i = 0; i < def.count; i++) {
    const id = `p${String(i + 1).padStart(2, '0')}`;
    if (def.tiny) {
      const bytes = Uint8Array.from(atob(TINY_PNG), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'image/png' });
      const t0 = performance.now();
      const s = await blobToSample(blob, quality);
      tDecode.push(performance.now() - t0);
      samples.push({ id, ...s });
      photos.push({ id, alpha: null, W: s.width, H: s.height, hasOverlay: false });
      continue;
    }
    const [W, H] = def.sizes ? def.sizes[i] : def.size;
    const T = await G.texturesFor(W, H);
    const dupe = def.dupes && def.dupes.find((d) => d[0] === i);
    let made;
    if (dupe) {
      const src = photos[dupe[1]];
      if (dupe[2] === 'exact') made = { blob: src.blob, alpha: src.alpha, W: src.W, H: src.H };
      else {
        const bmp = await createImageBitmap(src.blob);
        const c = G.canvas(src.W, src.H);
        c.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close();
        made = { blob: await G.toBlob(c, 'image/jpeg', 0.8), alpha: src.alpha, W: src.W, H: src.H };
      }
    } else if (def.placeholder) {
      const c = G.canvas(W, H);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#e9ecef';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#868e96';
      ctx.font = `bold ${Math.round(H * 0.07)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('PHOTOS COMING SOON', W / 2, H / 2);
      made = { blob: await G.toBlob(c, 'image/jpeg', 0.85), alpha: null, W, H };
    } else {
      let kind = def.without && def.without.includes(i) ? null : def.overlay || null;
      if (i === 0 && def.cover) kind = kind ? `${def.cover}+${kind}` : def.cover;
      const price = i === 0 && def.cover ? PRICES[0] : undefined;
      const counter = def.counter ? `Photo ${i + 1} of ${def.count}` : undefined;
      made = await makePhoto(def, car, plan[i], r, T, W, H, kind, price, i === 0 && def.coverSpot != null ? def.coverSpot : def.spot, counter);
    }
    const t0 = performance.now();
    const s = await blobToSample(made.blob, quality);
    tDecode.push(performance.now() - t0);
    samples.push({ id, ...s });
    let hasOverlay = false;
    let hasSee = false;
    if (made.alpha && !def.overlayIsNotBranding) for (let k = 0; k < made.alpha.length; k++) {
      if (made.alpha[k] > 127) { hasOverlay = true; break; }
      if (made.alpha[k] > 25) hasSee = true;
    }
    photos.push({ id, blob: made.blob, alpha: made.alpha, W: made.W, H: made.H, hasOverlay, hasSee: hasSee && !hasOverlay });
  }
  // ---- other cars' covers (the lot) ----
  const lot = [];
  if (def.lot) {
    for (let k = 0; k < def.lot.count; k++) {
      const rr = G.rngOf(def.seed * 104729 + k * 31);
      const other = G.makeCar(rr);
      const [W, H] = def.size;
      const T = await G.texturesFor(W, H);
      const price = def.lot.prices === true ? PRICES[k + 1] : def.lot.prices === 'some' && k % 2 ? PRICES[k + 1] : undefined;
      const shot = { type: 'ext', view: rr.pick(['three', 'three', 'side', 'front']) };
      const made = await makePhoto({ ...def, cdn: null }, other, shot, rr, T, W, H, def.lot.overlay, price, def.lot.spot);
      const s = await blobToSample(made.blob, quality);
      lot.push({ key: `car${k}`, ...PB.lotSample(s) });
    }
  }
  // ---- the check ----
  const input = samples.map((s) => ({ id: s.id, width: s.width, height: s.height, w: s.w, h: s.h, rgba: s.rgba }));
  const t0 = performance.now();
  // debug only adds result.groups (what each group of photos found)
  const result = PB.findBranding(input, { lot, tuning: { ...(tuning || {}), debug: true } });
  const tCheck = performance.now() - t0;
  // ---- metrics ----
  const per = [];
  for (const p of photos) {
    const e = result.photos[p.id];
    const m = metricsFor(e, p.alpha, p.W, p.H);
    per.push({ id: p.id, status: e.status, left: e.left, reason: e.reason, sides: e.sides, crop: e.crop, hasOverlay: p.hasOverlay, hasSee: Boolean(p.hasSee), ...m });
  }
  const summary = summarise(def, per);
  const out = {
    name,
    expect: def.expect,
    photos: def.count,
    size: def.sizes ? 'mixed' : def.size.join('x'),
    lot: lot.length,
    statuses: countBy(per, (p) => p.status + (p.left ? '/' + p.left : '') + (p.reason ? '/' + p.reason : '')),
    groups: result.groups,
    summaryLine: PB.brandingSummary(result.photos, per.map((p) => p.id)),
    notes: per.slice(0, 3).map((p) => PB.photoNote(result.photos[p.id])),
    ...summary,
    ms: { check: +tCheck.toFixed(1), decodeAvg: +(tDecode.reduce((a, b) => a + b, 0) / tDecode.length).toFixed(1) },
    per: opts.detail ? per : undefined,
  };
  if (opts.sheet) out.sheet = await sheet(photos, samples, result);
  return out;
}

function countBy(arr, f) {
  const o = {};
  for (const x of arr) o[f(x)] = (o[f(x)] || 0) + 1;
  return o;
}

function summarise(def, per) {
  const s = { falseCrops: 0, falseFlags: 0, misses: 0, lies: 0, opaqueLeftMax: 0, insideReported: 0, fringeMax: 0, stripMax: 0, maxAlphaInMax: 0, lostCleanMean: 0, lostCleanMax: 0, cropped: 0 };
  let lostSum = 0;
  for (const p of per) {
    if (p.hasSee) {
      // a see-through mark only: not looked for; a crop that leaves it in may not pass as clean
      if (p.status === 'cropped' && !p.left && p.maxAlphaIn > 0.02) s.lies++;
      if (p.status === 'none') s.misses++;
    } else if (!p.hasOverlay) {
      if (p.status === 'cropped') s.falseCrops++;
      if (p.status === 'kept') s.falseFlags++;
    } else if (def.expect === 'positive' && p.status !== 'cropped') s.misses++;
    else if (def.expect === 'kept' && p.status === 'cropped' && !p.left) s.lies += p.opaqueLeft > 0 ? 1 : 0;
    else if (def.expect === 'kept' && p.status === 'none') s.misses++;
    if (p.status === 'cropped') {
      s.cropped++;
      if (!p.left && p.opaqueLeft > 0) s.lies++;
      if (p.left === 'inside') s.insideReported++;
      s.opaqueLeftMax = Math.max(s.opaqueLeftMax, p.left ? 0 : p.opaqueLeft);
      s.fringeMax = Math.max(s.fringeMax, p.fringeLeft);
      s.stripMax = Math.max(s.stripMax, p.strip);
      s.maxAlphaInMax = Math.max(s.maxAlphaInMax, p.left ? 0 : p.maxAlphaIn);
      lostSum += p.lostClean;
      s.lostCleanMax = Math.max(s.lostCleanMax, p.lostClean);
    }
  }
  s.lostCleanMean = s.cropped ? +(lostSum / s.cropped).toFixed(4) : 0;
  s.lostCleanMax = +s.lostCleanMax.toFixed(4);
  s.stripMax = +s.stripMax.toFixed(3);
  s.maxAlphaInMax = +s.maxAlphaInMax.toFixed(3);
  return s;
}

// A contact sheet: each check sample with its crop (green) or its status.
async function sheet(photos, samples, result) {
  const cols = 5;
  const tw = 256;
  const th = 192;
  const rows = Math.ceil(samples.length / cols);
  const c = G.canvas(cols * tw, rows * (th + 16));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const x = (i % cols) * tw;
    const y = Math.floor(i / cols) * (th + 16);
    if (s.rgba) {
      const id = new ImageData(new Uint8ClampedArray(s.rgba), s.w, s.h);
      const bmp = await createImageBitmap(id);
      const f = Math.min(tw / s.w, th / s.h);
      ctx.drawImage(bmp, x, y, s.w * f, s.h * f);
      const e = result.photos[s.id];
      if (e.crop) {
        ctx.strokeStyle = e.left ? '#ffb000' : '#00ff66';
        ctx.lineWidth = 2;
        const k = (s.w * f) / s.width;
        ctx.strokeRect(x + e.crop.x * k + 1, y + e.crop.y * k + 1, e.crop.w * k - 2, e.crop.h * k - 2);
      }
    }
    ctx.fillStyle = '#ddd';
    ctx.font = '11px sans-serif';
    const e = result.photos[s.id];
    ctx.fillText(`${s.id} ${e.status}${e.left ? '/' + e.left : ''}${e.reason ? '/' + e.reason : ''}`, x + 4, y + th + 12);
  }
  const b = await G.toBlob(c, 'image/png');
  const buf = new Uint8Array(await b.arrayBuffer());
  let str = '';
  for (let i = 0; i < buf.length; i += 0x8000) str += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(str);
}

// Timing: N photos at W x H (bottom band on all): decode + check sample per
// photo, the check per car, and one crop saved as JPEG.
export async function runTiming(W, H, count, opts = {}) {
  const r = G.rngOf(W * 31 + count);
  const car = G.makeCar(r);
  const plan = G.galleryPlan(count, r, {});
  const T = await G.texturesFor(W, H);
  const blobs = [];
  const ov = overlayFor('bottomBand', W, H);
  for (let i = 0; i < count; i++) {
    const photo = G.renderPhoto(W, H, car, plan[i], r, T, {});
    blobs.push(await G.vendorPhoto(photo, ov.canvas, 0.85));
  }
  const bytes = blobs.reduce((a, b) => a + b.size, 0);
  const quality = opts.quality || 'high';
  const t0 = performance.now();
  const samples = [];
  for (let i = 0; i < count; i++) samples.push({ id: 'p' + i, ...(await G.decodeSample(blobs[i], PB.checkSize, quality)) });
  const tDecode = performance.now() - t0;
  const t1 = performance.now();
  const result = PB.findBranding(samples, {});
  const tCheck = performance.now() - t1;
  const e = result.photos.p0;
  let tCrop = null;
  if (e.crop) {
    const t2 = performance.now();
    const out = await G.applyCrop(blobs[0], e.crop, 0.92);
    tCrop = { ms: +(performance.now() - t2).toFixed(1), bytes: out.size, origBytes: blobs[0].size };
  }
  return {
    size: `${W}x${H}`,
    count,
    jpegMB: +(bytes / 1048576).toFixed(1),
    decodeTotalMs: +tDecode.toFixed(0),
    decodePerPhotoMs: +(tDecode / count).toFixed(1),
    checkMs: +tCheck.toFixed(0),
    cropOneMs: tCrop,
    status: e.status,
    sampleMB: +((samples.reduce((a, s) => a + s.rgba.length, 0)) / 1048576).toFixed(1),
  };
}
