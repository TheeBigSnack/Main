// Finds the overlay a dealer's photo vendor lays over a car's photos (logo
// bands, top bars, frames, corner badges) and works out a crop that cuts it
// off. Pure: no DOM, no chrome.*, no imports, nothing about any one website.
// The side panel decodes each photo, draws it at checkSize() and passes the
// pixels in (src/photoCanvas.js); this module only reads numbers and returns
// rectangles and words.
//
// The idea: a vendor overlay is a transparent PNG laid over every photo (or
// only over the first one) at the same pixel positions. So pixels that keep
// the same colour in the same place across many different photos of a car
// are overlay; photo content changes from shot to shot. An overlay that is
// only on each car's cover photo shows up the same way across the cover
// photos of several cars from the same website (the "lot", kept as small
// samples in coverSamples:<origin>, withCover/otherCovers below).
//
// Crop only: a crop is always a sub-rectangle of the website's photo.
// Nothing is painted over, blurred or invented. (The side panel saves the
// part kept as a new file, src/photoCanvas.js: compressed again, in standard
// colours, without the website file's embedded details.)
// A logo that can't be cropped off is reported, never hidden, and a photo that
// doesn't itself carry the overlay is never cropped. Only strips along the
// edges are cut (a band, see-through or solid, with lettering in it; a frame;
// the strip a corner logo sits in). A solid logo in the middle of the picture
// stays and is reported. See-through watermarks inside the picture are not
// removed and not looked for: one can't be told from the backdrop of a spot
// where every car is photographed. Branding on the car itself (a plate frame,
// a sticker) moves with the car from photo to photo, so it is never overlay.
//
// What else can stay put across photos, and how it is told apart: a part of
// the picture that never changes (a booth with a fixed camera) is too much of
// the photo (too alike), or a mark whose brightness follows each photo's
// exposure (scene), or, next to a band, a strip that doesn't follow the
// changing photo beside it (not a see-through band), or that follows it in
// full (a sky, which varies less than the rest but is not dimmed or
// lightened by a band laid over it).

export const CHECK_LONG_SIDE = 256; // each photo is drawn at this long side for the check (aspect kept, never upscaled)
export const LOT_LONG_SIDE = 128; // stored cover samples: a 2x2 box downscale of a check sample (lotSample)
export const MIN_PHOTOS = 4; // distinct same-size photos (this car's, or other cars' covers) a check needs: fewer can agree by chance
export const MIN_SIDE = 200; // natural px; a photo whose shorter side is smaller is not checked (too few pixels to tell a logo from the picture)
export const MAX_CHECK_PHOTOS = 40; // at most this many photos are downloaded for one check, and used as evidence per size
export const COVER_SAMPLE_CARS = 8; // cover samples of other cars kept per website (coverSamples:<origin>)

// Every number below is in check pixels at CHECK_LONG_SIDE (or a share of a
// side or of the photo), and is scaled for the 128-px lot samples. None of
// them comes from one dealer's photos: each was measured on synthetic
// galleries (bands, frames, badges, fixed cameras, booths, placeholders) for
// no crop of a photo without the overlay and no crop called clean with an
// overlay pixel left in it.
export const TUNING = Object.freeze({
  tol: 12, // "same colour": largest channel difference from the per-pixel median
  share: 0.8, // ...in at least this share of the photos (and never fewer than MIN_PHOTOS)
  dupTol: 6, // two samples are the same photo when this share of pixels...
  dupAgree: 0.985, // ...differ by at most dupTol
  speck: 6, // overlay specks smaller than this (px) are dropped
  detailContrast: 48, // a designed mark: two neighbouring overlay pixels this different (text, logo edges)
  detailMin: 12, // ...at least this many such pixels (px) before a region counts as a designed mark
  bandRow: 0.5, // a line belongs to an edge band when this share of it is overlay
  bandAvg: 0.75, // a band's lines average at least this
  flatBandAvg: 0.97, // a band with no text or logo in it must be this solid...
  flatBreak: 0.1, // ...and end this cleanly
  breakMax: 0.35, // the lines just past a band are at most this share overlay (a straight inner edge)
  breakRows: 3, // ...over this many lines
  maxBand: 0.3, // a band is at most this share of the side (a deeper "band" is more likely the picture)
  margin: 2, // px cut past every detected overlay edge (the blended line plus one)
  extMax: 0.06, // a shadow or soft edge past a band: at most this share of the side
  extStart: 0.6, // ...starts when the line past the band varies at most this much of the photo just beyond...
  extKeep: 0.85, // ...and continues while it varies at most this much
  extMinPhotos: 8, // ...judged only from at least this many distinct photos
  refLen: 0.05, // the reference stretch of photo past a band (share of the side)
  refMin: 6, // the reference must vary at least this much between photos to compare against
  softRatio: 0.5, // a see-through band: varies at most this share of the photo just past it
  softMin: 0.03, // ...and is at least this deep (share of the side)
  softGrow: 0.7, // ...and reaches on while its lines vary at most this share of the photo past it
  softFollow: 0.5, // ...and the photo goes on under it: brightness just inside its edge follows just outside (correlation)
  softMinPhotos: 4, // ...judged only from at least this many distinct photos
  stripRatio: 0.8, // a mark at an edge sits in a see-through strip when the lines from the edge past it vary at most this share of the photo beyond
  tooAlike: 0.5, // overlay over this share of the photo: the photos are too alike to tell
  insideMax: 0.1, // overlay marks inside the photo (not edge bands) over this share: too alike
  coreSigma: 3, // a part's steady pixels: at least half the photos within this of the median
  match: 0.85, // a photo carries an overlay part when it matches this share of the part's steady pixels...
  matchDetail: 0.85, // ...and this share of its text and logo edges
  matchParts: 0.75, // a band or mark is carried when regions holding this share of its pixels are
  keepArea: 0.6, // a crop keeps at least this share of the photo (else the photo goes on as the website shows it)
  markKeep: 0.8, // stepping around a mark inside keeps at least this share of what the band cuts leave
  aspect: 1.5, // ...and its shape stays within this factor of the photo's
  shiftMax: 1.5, // a mark whose brightness follows each photo's exposure by this much (%) is scene, not overlay
});

// Why a photo was not checked. The first three are this module's; the rest
// come from the caller, which could not read the photo: a format it doesn't
// decode, a decode that failed, a download that failed, a photo server it may
// not read, a download that took too long.
const CALLER_REASONS = new Set(['format', 'decode', 'download', 'server', 'slow']);

const SIDES = ['top', 'right', 'bottom', 'left'];

/**
 * The size a photo is drawn at for the check: the long side CHECK_LONG_SIDE
 * (never larger than the photo), aspect kept. null for a photo that is not
 * checked (not a real size, or the shorter side under MIN_SIDE).
 */
export function checkSize(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const W = Math.floor(width);
  const H = Math.floor(height);
  if (W < 1 || H < 1 || Math.min(W, H) < MIN_SIDE) return null;
  const long = Math.max(W, H);
  if (long <= CHECK_LONG_SIDE) return { w: W, h: H };
  const s = CHECK_LONG_SIDE / long;
  return { w: Math.max(1, Math.round(W * s)), h: Math.max(1, Math.round(H * s)) };
}

/**
 * The small sample of a cover photo kept for the lot check: a 2x2 box
 * average of its check sample ({ width, height, w, h, rgba }), RGB only, at
 * most LOT_LONG_SIDE across (about 36 KB at 128x96). Returns
 * { width, height, w, h, rgb } with width/height the photo's natural size.
 */
export function lotSample(sample) {
  const { width, height, w, h, rgba } = sample;
  const lw = w >> 1;
  const lh = h >> 1;
  const rgb = new Uint8Array(lw * lh * 3);
  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      const i0 = (2 * y * w + 2 * x) * 4;
      const i1 = i0 + 4;
      const i2 = i0 + w * 4;
      const i3 = i2 + 4;
      const o = (y * lw + x) * 3;
      rgb[o] = (rgba[i0] + rgba[i1] + rgba[i2] + rgba[i3] + 2) >> 2;
      rgb[o + 1] = (rgba[i0 + 1] + rgba[i1 + 1] + rgba[i2 + 1] + rgba[i3 + 1] + 2) >> 2;
      rgb[o + 2] = (rgba[i0 + 2] + rgba[i1 + 2] + rgba[i2 + 2] + rgba[i3 + 2] + 2) >> 2;
    }
  }
  return { width, height, w: lw, h: lh, rgb };
}

// ---------- small helpers ----------

// A sample's pixels as { data, stride } (RGBA check samples, RGB lot samples).
// Every sample is read through a plain Uint8Array (getImageData gives a
// Uint8ClampedArray): one array type keeps the hot loops fast.
const view = (data, stride) => ({ data: data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.length), stride });

function scaled(cfg, scale) {
  // scale = grid long side / CHECK_LONG_SIDE (1 for check samples, 0.5 for lot samples)
  const a = scale * scale;
  return {
    ...cfg,
    speck: Math.max(2, Math.round(cfg.speck * a)),
    detailMin: Math.max(4, Math.round(cfg.detailMin * a)),
    breakRows: Math.max(2, Math.round(cfg.breakRows * scale)),
    margin: Math.max(1, Math.round(cfg.margin * scale)),
  };
}

function maxDiff3(a, ai, b, bi) {
  let d = a[ai] - b[bi];
  if (d < 0) d = -d;
  let e = a[ai + 1] - b[bi + 1];
  if (e < 0) e = -e;
  if (e > d) d = e;
  e = a[ai + 2] - b[bi + 2];
  if (e < 0) e = -e;
  return e > d ? e : d;
}

// Are two samples the same photo (a repeat, or the same photo saved again)?
function samePhoto(a, b, P, cfg) {
  // quick reject on a coarse comparison, then the full one
  let far = 0;
  const step = 97;
  let n = 0;
  for (let p = 0; p < P; p += step, n++) if (maxDiff3(a.data, p * a.stride, b.data, p * b.stride) > cfg.dupTol * 3) far++;
  if (far > n * 0.1) return false;
  let close = 0;
  for (let p = 0; p < P; p++) if (maxDiff3(a.data, p * a.stride, b.data, p * b.stride) <= cfg.dupTol) close++;
  return close >= cfg.dupAgree * P;
}

// ---------- the per-pixel statistics of a set of same-size samples ----------

function pixelStats(views, P, cfg, need) {
  const n = views.length;
  const lo = (n - 1) >> 1;
  const hi = n >> 1;
  const tol = cfg.tol;
  // pixel-major copies: the n photos' values of one pixel side by side
  const L0 = new Uint8Array(P * n);
  const L1 = new Uint8Array(P * n);
  const L2 = new Uint8Array(P * n);
  const LY = new Uint8Array(P * n);
  for (let i = 0; i < n; i++) {
    const d = views[i].data;
    const s = views[i].stride;
    for (let p = 0, q = 0, o = i; p < P; p++, q += s, o += n) {
      const r = d[q];
      const g = d[q + 1];
      const b = d[q + 2];
      L0[o] = r;
      L1[o] = g;
      L2[o] = b;
      LY[o] = (77 * r + 150 * g + 29 * b + 128) >> 8;
    }
  }
  const med = new Uint8Array(P * 3); // per-channel median (where enough photos could agree)
  const dev = new Uint8Array(n * P).fill(255); // each photo's largest channel difference from it (photo-major)
  const cnt = new Uint8Array(P); // how many photos agree with it within tol
  const sigma = new Uint8Array(P); // how much the photos vary here: median distance from the median luma
  const core = new Uint8Array(P).fill(255); // the same in full colour, where enough photos could agree
  const medY = new Uint8Array(P); // the median brightness
  const buf = new Uint8Array(n);
  const lane = [L0, L1, L2];
  for (let p = 0, o = 0; p < P; p++, o += n) {
    for (let i = 0; i < n; i++) {
      const v = LY[o + i];
      let j = i - 1;
      while (j >= 0 && buf[j] > v) {
        buf[j + 1] = buf[j];
        j--;
      }
      buf[j + 1] = v;
    }
    const m = (buf[lo] + buf[hi] + 1) >> 1;
    medY[p] = m;
    // the (lo+1)-th smallest distance from m, merging both sides of the sorted values
    let a = hi;
    while (a > 0 && buf[a - 1] >= m) a--;
    let l = a - 1;
    let r = a;
    let d = 0;
    let within = 0;
    for (let k = 0; k <= lo; k++) {
      const dl = l >= 0 ? m - buf[l] : 256;
      const dr = r < n ? buf[r] - m : 256;
      if (dl <= dr) {
        d = dl;
        l--;
      } else {
        d = dr;
        r++;
      }
    }
    sigma[p] = d;
    for (let i = 0; i < n; i++) {
      const e = buf[i] - m;
      if (e <= tol && e >= -tol) within++;
    }
    cnt[p] = within;
    if (within < need) continue; // luma already says too few photos agree here
    for (let c = 0; c < 3; c++) {
      const L = lane[c];
      for (let i = 0; i < n; i++) {
        const v = L[o + i];
        let j = i - 1;
        while (j >= 0 && buf[j] > v) {
          buf[j + 1] = buf[j];
          j--;
        }
        buf[j + 1] = v;
      }
      med[p * 3 + c] = (buf[lo] + buf[hi] + 1) >> 1;
    }
    const m0 = med[p * 3];
    const m1 = med[p * 3 + 1];
    const m2 = med[p * 3 + 2];
    let k = 0;
    for (let i = 0; i < n; i++) {
      let x = L0[o + i] - m0;
      if (x < 0) x = -x;
      let y = L1[o + i] - m1;
      if (y < 0) y = -y;
      if (y > x) x = y;
      y = L2[o + i] - m2;
      if (y < 0) y = -y;
      if (y > x) x = y;
      dev[i * P + p] = x;
      if (x <= tol) k++;
      let j = i - 1;
      while (j >= 0 && buf[j] > x) {
        buf[j + 1] = buf[j];
        j--;
      }
      buf[j + 1] = x;
    }
    cnt[p] = k;
    core[p] = buf[lo];
  }
  return { med, dev, cnt, sigma, core, LY, medY };
}

// How much a region's brightness moves with each photo's exposure: per
// photo, the median over the region of (photo brightness + 1) / (median
// brightness + 1), in steps of 0.5%; then the median over the photos of how
// far that is from 1, in percent. 0 for a solid overlay (the photos that
// carry it show it unchanged, and they are most of them); about the typical
// exposure change for a part of the picture that never changes. A
// see-through overlay over dark photo content moves too (it lets the photo
// through), so this is only asked of marks inside the photo, never of bands.
function exposureShift(px, n, LY, medY) {
  const ds = new Float64Array(n);
  const hist = new Uint32Array(201);
  const half = px.length / 2;
  for (let i = 0; i < n; i++) {
    hist.fill(0);
    for (let k = 0; k < px.length; k++) {
      const p = px[k];
      let b = Math.round(((LY[p * n + i] + 1) / (medY[p] + 1) - 0.5) * 200);
      if (b < 0) b = 0;
      else if (b > 200) b = 200;
      hist[b]++;
    }
    let acc = 0;
    let b = 0;
    for (; b < 200; b++) {
      acc += hist[b];
      if (acc >= half) break;
    }
    ds[i] = Math.abs(b - 100) / 2;
  }
  ds.sort();
  return ds[n >> 1];
}

// 8-connected regions of a mask; each with its pixels.
function regions(mask, w, h) {
  const P = w * h;
  const lab = new Int32Array(P);
  const stack = new Int32Array(P);
  const out = [];
  for (let p0 = 0; p0 < P; p0++) {
    if (!mask[p0] || lab[p0]) continue;
    const id = out.length + 1;
    let sp = 0;
    stack[sp++] = p0;
    lab[p0] = id;
    const px = [];
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    while (sp) {
      const p = stack[--sp];
      px.push(p);
      const x = p % w;
      const y = (p - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (mask[q] && !lab[q]) {
            lab[q] = id;
            stack[sp++] = q;
          }
        }
      }
    }
    out.push({ id, pixels: Int32Array.from(px), box: { x0, y0, x1: x1 + 1, y1: y1 + 1 } });
  }
  return { lab, list: out };
}

// ---------- lines of a rectangle, counted from one side inward ----------

const lineLen = (R, side) => (side === 'top' || side === 'bottom' ? R.x1 - R.x0 : R.y1 - R.y0);
const room = (R, side) => (side === 'top' || side === 'bottom' ? R.y1 - R.y0 : R.x1 - R.x0);

function lineCount(mask, w, R, side, k) {
  let c = 0;
  if (side === 'top' || side === 'bottom') {
    const y = side === 'top' ? R.y0 + k : R.y1 - 1 - k;
    const base = y * w;
    for (let x = R.x0; x < R.x1; x++) c += mask[base + x];
  } else {
    const x = side === 'left' ? R.x0 + k : R.x1 - 1 - k;
    for (let y = R.y0; y < R.y1; y++) c += mask[y * w + x];
  }
  return c;
}

// The median of `values` along each line k in [from, to).
function lineMedians(values, w, R, side, from, to) {
  const out = [];
  const hist = new Uint32Array(256);
  const lim = Math.min(to, room(R, side));
  for (let k = from; k < lim; k++) {
    hist.fill(0);
    let n = 0;
    if (side === 'top' || side === 'bottom') {
      const y = side === 'top' ? R.y0 + k : R.y1 - 1 - k;
      for (let x = R.x0; x < R.x1; x++, n++) hist[values[y * w + x]]++;
    } else {
      const x = side === 'left' ? R.x0 + k : R.x1 - 1 - k;
      for (let y = R.y0; y < R.y1; y++, n++) hist[values[y * w + x]]++;
    }
    let acc = 0;
    let v = 0;
    for (; v < 256; v++) {
      acc += hist[v];
      if (acc * 2 >= n) break;
    }
    out.push(v);
  }
  return out;
}

function quantile(arr, from, to, q) {
  const s = arr.slice(from, to).sort((a, b) => a - b);
  if (!s.length) return 0;
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
}

function shrink(R, side, by) {
  const r = { ...R };
  if (side === 'top') r.y0 += by;
  else if (side === 'bottom') r.y1 -= by;
  else if (side === 'left') r.x0 += by;
  else r.x1 -= by;
  return r;
}

// The line of side `side` of R that pixel p is on (0 at the edge).
function lineIn(p, w, R, side) {
  const x = p % w;
  const y = (p - x) / w;
  return side === 'top' ? y - R.y0 : side === 'bottom' ? R.y1 - 1 - y : side === 'left' ? x - R.x0 : R.x1 - 1 - x;
}

const sideDim = (side, w, h) => (side === 'top' || side === 'bottom' ? h : w);

// The pixels of `mask` in the zone of lines [0, depth) of side `side` of R.
function zonePixels(mask, w, R, side, depth) {
  const out = [];
  for (let k = 0; k < depth; k++) {
    if (side === 'top' || side === 'bottom') {
      const y = side === 'top' ? R.y0 + k : R.y1 - 1 - k;
      for (let x = R.x0; x < R.x1; x++) if (mask[y * w + x]) out.push(y * w + x);
    } else {
      const x = side === 'left' ? R.x0 + k : R.x1 - 1 - k;
      for (let y = R.y0; y < R.y1; y++) if (mask[y * w + x]) out.push(y * w + x);
    }
  }
  return Int32Array.from(out);
}

// ---------- bands ----------

// An opaque band along one side of R: lines that are mostly overlay, from the
// edge inward, ending at a straight, clean inner edge.
function findBand(M, D, V, w, h, R, side, cfg, allowFlat) {
  const len = lineLen(R, side);
  const space = room(R, side);
  if (len <= 0 || space <= 2) return null;
  const maxDepth = Math.min(Math.floor(cfg.maxBand * sideDim(side, w, h)), space - 1);
  const fr = (k) => lineCount(M, w, R, side, k) / len;
  let depth = 0;
  let sum = 0;
  while (depth < maxDepth) {
    const f = fr(depth);
    if (f >= cfg.bandRow) {
      sum += f;
      depth++;
      continue;
    }
    // one weaker line inside a band (a hole such as a per-car price) is allowed
    if (depth > 0 && depth + 1 < maxDepth && f >= cfg.bandRow / 2 && fr(depth + 1) >= cfg.bandRow) {
      sum += f;
      depth++;
      continue;
    }
    break;
  }
  if (!depth || depth >= maxDepth) return null;
  let det = 0;
  let inV = 0;
  let inM = 0;
  for (let k = 0; k < depth; k++) {
    det += lineCount(D, w, R, side, k);
    inV += lineCount(V, w, R, side, k);
    inM += lineCount(M, w, R, side, k);
  }
  // detailed: text or logo edges in the band, or the band is part of a
  // region that has them (the plain sides of a frame whose logo is below)
  const detailed = det >= cfg.detailMin || (inV > 0 && inV >= 0.5 * inM);
  if (!detailed && !allowFlat) return null;
  const avg = sum / depth;
  if (avg < (detailed ? cfg.bandAvg : cfg.flatBandAvg)) return null;
  if (!detailed && depth < 2) return null;
  let brk = 0;
  for (let k = depth + 1; k < Math.min(space, depth + 1 + cfg.breakRows); k++) brk = Math.max(brk, fr(k));
  if (brk > (detailed ? cfg.breakMax : cfg.flatBreak)) return null;
  return { side, depth, detailed, avg, brk };
}

// How far a shadow or soft edge reaches past a band: lines whose spread
// between photos is clearly lower than the photo's just beyond.
function extension(sigma, w, h, R, side, depth, cfg, n) {
  // a few photos (or a lot of similar covers) don't say how much the photo
  // itself varies next to the band: no extension, only the margin
  if (n < cfg.extMinPhotos) return 0;
  const dim = sideDim(side, w, h);
  const extMax = Math.max(2, Math.round(cfg.extMax * dim));
  const refLen = Math.max(3, Math.round(cfg.refLen * dim));
  const q = lineMedians(sigma, w, R, side, depth, depth + extMax + refLen);
  if (q.length < extMax + 2) return 0;
  const ref = quantile(q, extMax, q.length, 0.5);
  if (ref < cfg.refMin) return 0;
  if (q[1] > cfg.extStart * ref) return 0;
  let e = 2;
  while (e < extMax && q[e] <= cfg.extKeep * ref) e++;
  // a shadow fades out; a stretch that stays steady all the way is the photo
  // itself (a sky, a studio floor), not something to cut
  return e < extMax ? e : 0;
}

// Every pixel of lines [from, to) of side `side` of R.
function linePixels(w, R, side, from, to) {
  const out = [];
  const lim = Math.min(to, room(R, side));
  for (let k = from; k < lim; k++) {
    if (side === 'top' || side === 'bottom') {
      const y = side === 'top' ? R.y0 + k : R.y1 - 1 - k;
      for (let x = R.x0; x < R.x1; x++) out.push(y * w + x);
    } else {
      const x = side === 'left' ? R.x0 + k : R.x1 - 1 - k;
      for (let y = R.y0; y < R.y1; y++) out.push(y * w + x);
    }
  }
  return Int32Array.from(out);
}


// How closely each photo's brightness just inside a band's edge follows its
// brightness just outside it: the median, along the edge, of the correlation
// across photos between the line 3 in from the edge and the line 2 past it.
// Near 1 when the photo goes on under a see-through band; near 0 when the
// inside stays put (an opaque band, or a part of the picture that never
// changes) while the photo next to it changes (follow). And how much of the
// change outside the edge shows inside it from photo to photo (the median
// slope): near 1 when the photo just goes on (a sky, a wall), about
// 1 - opacity under a see-through band, which dims or lightens every photo
// by the same share.
function edgeFit(tmpl, w, R, side, depth) {
  const { n, LY } = tmpl;
  const a = linePixels(w, R, side, Math.max(0, depth - 3), Math.max(1, depth - 2));
  const b = linePixels(w, R, side, depth + 2, depth + 3);
  const L = Math.min(a.length, b.length);
  if (!L || n < 3) return { follow: 0, slope: 1 };
  const cs = new Float64Array(L);
  const ss = new Float64Array(L);
  for (let k = 0; k < L; k++) {
    const pa = a[k] * n;
    const pb = b[k] * n;
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let i = 0; i < n; i++) {
      const x = LY[pa + i];
      const y = LY[pb + i];
      sa += x;
      sb += y;
      saa += x * x;
      sbb += y * y;
      sab += x * y;
    }
    const va = saa / n - (sa / n) ** 2;
    const vb = sbb / n - (sb / n) ** 2;
    const cov = sab / n - (sa / n) * (sb / n);
    cs[k] = va >= 1 && vb >= 1 ? cov / Math.sqrt(va * vb) : 0;
    ss[k] = vb >= 1 ? cov / vb : 1;
  }
  cs.sort();
  ss.sort();
  return { follow: cs[L >> 1], slope: ss[L >> 1] };
}

// The lettering of a see-through band, told by its contrast with the band:
// a steady pixel (M) next to a pixel of the band itself (in lines [0, depth)
// of the side, not steady, varying at most `calm` between photos) whose
// median brightness is clearly different. Opaque lettering of one colour has
// no steady neighbour of another colour (the band around it changes with
// each photo), so the detail between steady pixels (D) misses it. Returns
// [p, q, p, q, ...]: each such pixel with the band pixel it stands out from,
// so a photo can be matched on that contrast being there (carries).
function letterEdges(M, sigma, medY, w, h, R, side, depth, calm, cfg) {
  const lineOf = (x, y) => (side === 'top' ? y - R.y0 : side === 'bottom' ? R.y1 - 1 - y : side === 'left' ? x - R.x0 : R.x1 - 1 - x);
  const inZone = (x, y) => x >= R.x0 && x < R.x1 && y >= R.y0 && y < R.y1 && lineOf(x, y) < depth;
  const out = [];
  for (const p of zonePixels(M, w, R, side, depth)) {
    const x = p % w;
    const y = (p - x) / w;
    let partner = -1;
    for (let dy = -1; dy <= 1 && partner < 0; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= w || yy >= h || !inZone(xx, yy)) continue;
        const q = yy * w + xx;
        if (M[q] || sigma[q] > calm) continue;
        const d = medY[p] - medY[q];
        if (d >= cfg.detailContrast || -d >= cfg.detailContrast) {
          partner = q;
          break;
        }
      }
    }
    if (partner >= 0) out.push(p, partner);
  }
  return out;
}

// A see-through band (a darkened or lightened strip the photo shows through)
// along one side of R: lines whose spread between photos is a fraction of the
// photo's just beyond, with designed marks (opaque text or logo) inside: the
// detail between steady pixels, or lettering that stands out from the band
// (letterEdges).
function softBand(sigma, D, M, w, h, R, side, cfg, tmpl) {
  const dim = sideDim(side, w, h);
  const space = room(R, side);
  const refLen = Math.max(3, Math.round(cfg.refLen * dim));
  const maxDepth = Math.min(Math.floor(cfg.maxBand * dim), space - refLen - 2);
  const minDepth = Math.max(2, Math.round(cfg.softMin * dim));
  if (maxDepth < minDepth) return null;
  const q = lineMedians(sigma, w, R, side, 0, maxDepth + refLen + 1);
  const past = Math.max(2, Math.round(cfg.extMax * dim));
  // the depth in [lo, hi] whose lines vary least against the photo past them
  const edgeIn = (lo, hi) => {
    let best = null;
    for (let d = lo; d <= hi && d + 1 + refLen <= q.length; d++) {
      const ref = quantile(q, d + 1, d + 1 + refLen, 0.5);
      if (ref < cfg.refMin) continue;
      const inside = quantile(q, 0, d, 0.8);
      const ratio = inside / ref;
      if (ratio <= cfg.softRatio && (!best || ratio < best.ratio)) best = { depth: d, ratio, ref };
    }
    if (!best) return null;
    // the depth with the lowest ratio can stop short of the band's inner edge
    // (its last lines blend into the photo): go on while the lines still vary
    // clearly less than the photo past them
    const grow = Math.min(hi, best.depth + past);
    while (best.depth < grow && q[best.depth] <= cfg.softGrow * best.ref) best.depth++;
    return best;
  };
  // the designed marks in lines [0, depth): detail between steady pixels and
  // lettering that stands out from the band, and the first and last line they reach
  const held = (best) => {
    let det = 0;
    let first = -1;
    let last = -1;
    for (let k = 0; k < best.depth; k++) {
      const c = lineCount(D, w, R, side, k);
      det += c;
      if (c && first < 0) first = k;
      if (c) last = k;
    }
    const letters = letterEdges(M, sigma, tmpl.medY, w, h, R, side, best.depth, cfg.softGrow * best.ref, cfg);
    for (let i = 0; i < letters.length; i += 2) {
      const k = lineIn(letters[i], w, R, side);
      if (first < 0 || k < first) first = k;
      if (k > last) last = k;
    }
    // a band is laid out around what it holds: it reaches past its lettering
    // or logo by about as much as it leaves between them and the edge
    return { enough: det + letters.length / 2 >= cfg.detailMin, letters, last, reach: last + 1 + Math.max(first, cfg.margin) + past };
  };
  let best = edgeIn(minDepth, maxDepth);
  if (!best) return null;
  let marks = held(best);
  if (!marks.enough) return null;
  if (best.depth > marks.reach) {
    // a stretch that goes on well past the marks in it: the photo beside a
    // band that varies little (it would cut into the picture), or a part of
    // the picture itself (a sky that varies less than the ground, with a
    // corner logo over it). Its inner edge is looked for again within reach
    // of the marks, and the checks below tell a band from a sky there.
    best = edgeIn(Math.max(minDepth, marks.last + 1), Math.min(maxDepth, marks.reach));
    if (!best) return null;
    marks = held(best);
    if (!marks.enough || best.depth > marks.reach) return null;
  }
  // the photo goes on under a see-through band: just inside its edge each
  // photo shows, dimmed or lightened, what it shows just outside, so the two
  // rise and fall together from photo to photo. A part of the picture that
  // never changes (the backdrop of a spot where every car is photographed)
  // varies little too, but it doesn't follow the changing photo next to it.
  // And a band dims or lightens every photo by one share, so the change from
  // photo to photo shows through it by clearly less than in full (markStrip);
  // a sky goes on across the line in full.
  if (tmpl.n < cfg.softMinPhotos) return null;
  const fit = edgeFit(tmpl, w, R, side, best.depth);
  if (fit.follow < cfg.softFollow || fit.slope > cfg.stripRatio) return null;
  return { side, depth: best.depth, soft: true, detailed: true, ratio: best.ratio, follow: +fit.follow.toFixed(2), letters: marks.letters };
}

// A see-through strip along one side of R that a mark (a logo or text with
// edges of its own) sits in: a lighter tint than softBand finds, or one whose
// lettering it can't tell, still varies less between photos than the photo
// past it, and the photo goes on under it. Stepping around the mark alone
// would leave the rest of the strip in the photo, so the strip goes with the
// mark. Its depth (lines from the side) reaches past the mark; null when
// there is no such strip.
function markStrip(sigma, tmpl, w, h, R, box, side, cfg) {
  const inner = side === 'top' ? box.y1 - R.y0 : side === 'bottom' ? R.y1 - box.y0 : side === 'left' ? box.x1 - R.x0 : R.x1 - box.x0;
  if (inner < 1) return null;
  const dim = sideDim(side, w, h);
  const refLen = Math.max(3, Math.round(cfg.refLen * dim));
  const maxDepth = Math.min(Math.floor(cfg.maxBand * dim), room(R, side) - refLen - 2);
  if (maxDepth < inner || tmpl.n < cfg.softMinPhotos) return null;
  const q = lineMedians(sigma, w, R, side, 0, maxDepth + refLen + 1);
  // the strip's inner edge is just past the mark (a logo sits inside its band)
  const past = Math.max(2, Math.round(cfg.extMax * dim));
  let best = null;
  for (let d = inner; d <= Math.min(maxDepth, inner + past) && d + 1 + refLen <= q.length; d++) {
    const ref = quantile(q, d + 1, d + 1 + refLen, 0.5);
    if (ref < cfg.refMin) continue;
    const ratio = quantile(q, 0, d, 0.8) / ref;
    if (ratio <= cfg.stripRatio && (!best || ratio < best.ratio)) best = { depth: d, ratio, ref };
  }
  if (!best) return null;
  const grow = Math.min(maxDepth, best.depth + past);
  while (best.depth < grow && q[best.depth] <= cfg.softGrow * best.ref) best.depth++;
  // the photo goes on under it, dimmed or lightened: inside its edge each
  // photo follows what it shows just outside, but by clearly less (a part of
  // the photo that only varies less than the rest, such as a sky, follows
  // the photo next to it in full)
  const fit = edgeFit(tmpl, w, R, side, best.depth);
  if (fit.follow < cfg.softFollow || fit.slope > cfg.stripRatio) return null;
  return { side, depth: best.depth };
}

// ---------- the template: what the overlay of a set of samples is ----------

function analyse(views, w, h, cfg) {
  const P = w * h;
  const n = views.length;
  const need = Math.max(MIN_PHOTOS, Math.ceil(cfg.share * n));
  const { med, dev, cnt, sigma, core, LY, medY } = pixelStats(views, P, cfg, need);
  const raw = new Uint8Array(P);
  let rawCount = 0;
  for (let p = 0; p < P; p++) if (cnt[p] >= need) (raw[p] = 1), rawCount++;
  const base = { w, h, n, med, dev, cnt, sigma, core, LY, medY, need, parts: [], stats: { raw: rawCount / P } };

  // specks out
  const reg = regions(raw, w, h);
  let kept = reg.list.filter((r) => r.pixels.length >= cfg.speck);
  let mCount = 0;
  for (const r of kept) mCount += r.pixels.length;
  base.stats.mask = mCount / P;
  if (mCount > cfg.tooAlike * P) return { ...base, status: 'too-alike' };

  // A part of the picture that never changes (a sign on the wall of a booth
  // with a fixed camera) still gets brighter or darker with each photo's
  // exposure. A solid overlay is laid on after the camera, so every photo
  // that carries it shows it at the same brightness. Marks inside the photo
  // made of regions that move with the exposure are scene, not overlay: they
  // are dropped and the rest is laid out again. Bands are not asked (a
  // see-through band over dark photo content moves with the photo too).
  for (const r of kept) r.shift = exposureShift(r.pixels, n, LY, medY);
  let lay = layout(kept);
  const scene = new Set();
  for (const part of lay.found.marks) {
    for (const rid of regionsOf(part.pixels, lay.rl)) if (kept[rid].shift >= cfg.shiftMax) scene.add(rid);
  }
  for (const b of lay.found.bands) for (const rid of regionsOf(b.pixels, lay.rl)) scene.delete(rid);
  if (scene.size) {
    base.stats.scene = scene.size;
    kept = kept.filter((r, k) => !scene.has(k));
    lay = layout(kept);
  }
  const { D, rl, pairOf } = lay;
  const { bands, marks, R, insideCount } = lay.found;
  if (R.x1 - R.x0 < 2 || R.y1 - R.y0 < 2) return { ...base, status: 'too-alike' };
  base.stats.inside = insideCount / Math.max(1, (R.x1 - R.x0) * (R.y1 - R.y0));
  if (insideCount > cfg.insideMax * (R.x1 - R.x0) * (R.y1 - R.y0)) return { ...base, status: 'too-alike' };

  // the pixels a photo is matched on: nearly the same in at least half the photos
  const coreOf = (px) => {
    const out = [];
    for (const p of px) if (core[p] <= cfg.coreSigma) out.push(p);
    return Int32Array.from(out);
  };
  const parts = [];
  for (const b of bands) parts.push({ kind: 'band', side: b.side, cut: b.cut, depth: b.depth, ext: b.ext, soft: Boolean(b.soft), follow: b.follow, detailed: b.detailed, pixels: b.pixels, detailPixels: b.detailPixels });
  for (const m of marks) parts.push(m);
  // a photo is matched per overlay region (one connected piece of the
  // overlay, such as a whole frame), and every band or mark cut from that
  // region follows: the rounded corners of a frame go with its sides
  const pieces = new Map();
  parts.forEach((part, i) => {
    part.id = i;
    const counts = new Map();
    for (const p of part.pixels) {
      const k = rl[p] - 1;
      if (k >= 0) counts.set(k, (counts.get(k) || 0) + 1);
    }
    part.regions = [...counts.entries()].map(([rid, c]) => ({ rid, c }));
    part.shift = Math.max(0, ...part.regions.map(({ rid }) => kept[rid].shift));
    for (const { rid } of part.regions) {
      if (pieces.has(rid)) continue;
      const r = kept[rid];
      const det = [];
      const pairs = [];
      for (const p of r.pixels) {
        if (D[p]) det.push(p);
        if (pairOf[p] >= 0) pairs.push(p, pairOf[p]);
      }
      pieces.set(rid, { rid, pixels: r.pixels, detailPixels: Int32Array.from(det), corePixels: coreOf(r.pixels), coreDetail: coreOf(det), pairs: Int32Array.from(pairs) });
    }
  });
  return { ...base, status: parts.length ? 'found' : 'none', parts, pieces: [...pieces.values()], R };

  // The overlay mask, its detail and designed regions from a list of steady
  // regions, and the bands and marks laid out on them.
  function layout(list) {
    const M = new Uint8Array(P);
    const rl = new Int32Array(P);
    list.forEach((r, k) => {
      for (const p of r.pixels) {
        M[p] = 1;
        rl[p] = k + 1;
      }
    });
    // designed detail: two neighbouring overlay pixels of clearly different colour
    const D = new Uint8Array(P);
    for (const r of list) {
      let det = 0;
      for (const p of r.pixels) {
        const x = p % w;
        const y = (p - x) / w;
        let hit = 0;
        for (let dy = -1; dy <= 1 && !hit; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w || (!dx && !dy)) continue;
            const q = yy * w + xx;
            if (M[q] && maxDiff3(med, p * 3, med, q * 3) >= cfg.detailContrast) {
              hit = 1;
              break;
            }
          }
        }
        if (hit) {
          D[p] = 1;
          det++;
        }
      }
      r.detail = det;
    }
    // V: regions with designed detail (text, logos). Flat regions (a white
    // sky, a black corner) count only as a clean edge band.
    const V = new Uint8Array(P);
    for (const r of list) if (r.detail >= cfg.detailMin) for (const p of r.pixels) V[p] = 1;
    // edge bands, peeled from the outside in; then what is left inside
    // a see-through band's lettering and the band pixel each stands out from (letterEdges); -1 for none
    const pairOf = new Int32Array(P).fill(-1);
    let found = peel(list, M, D, V, rl, pairOf, true);
    // a plain band (no text or logo) is cut only as part of an overlay that has some
    if (found.bands.length && found.bands.every((b) => !b.detailed) && !found.marks.length) found = peel(list, M, D, V, rl, pairOf, false);
    return { M, D, V, rl, pairOf, found };
  }

  function peel(kept, M, D, V, rl, pairOf, allowFlat) {
    let R = { x0: 0, y0: 0, x1: w, y1: h };
    const bands = [];
    const done = new Set();
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (const side of SIDES) {
        if (done.has(side)) continue;
        const b = findBand(M, D, V, w, h, R, side, cfg, allowFlat);
        if (!b) continue;
        b.ext = extension(sigma, w, h, R, side, b.depth, cfg, n);
        b.cut = b.depth + Math.max(b.ext, 1) + cfg.margin - 1;
        b.pixels = zonePixels(M, w, R, side, b.depth);
        b.detailPixels = zonePixels(D, w, R, side, b.depth);
        bands.push(b);
        done.add(side);
        R = shrink(R, side, b.cut);
        changed = true;
      }
      if (!changed) break;
    }
    // see-through bands with opaque marks in them
    for (const side of SIDES) {
      if (done.has(side)) continue;
      const b = softBand(sigma, D, M, w, h, R, side, cfg, base);
      if (!b) continue;
      b.ext = extension(sigma, w, h, R, side, b.depth, cfg, n);
      b.cut = b.depth + Math.max(b.ext, 1) + cfg.margin - 1;
      // the regions of its lettering are overlay parts like designed ones
      for (let i = 0; i < b.letters.length; i += 2) {
        pairOf[b.letters[i]] = b.letters[i + 1];
        const r = kept[rl[b.letters[i]] - 1];
        if (r && !r.lettered) {
          r.lettered = true;
          for (const p of r.pixels) V[p] = 1;
        }
      }
      delete b.letters;
      b.pixels = zonePixels(V, w, R, side, b.depth);
      b.detailPixels = zonePixels(D, w, R, side, b.depth);
      bands.push(b);
      done.add(side);
      R = shrink(R, side, b.cut);
    }
    // marks left inside: designed regions with pixels inside R, or within
    // the margin of it (the blended edge of a rounded frame corner that ends
    // just outside R still reaches into it)
    const marks = [];
    let insideCount = 0;
    const m = cfg.margin;
    if (R.x1 - R.x0 >= 2 && R.y1 - R.y0 >= 2) {
      for (const r of kept) {
        if (r.detail < cfg.detailMin) continue;
        const near = [];
        for (const p of r.pixels) {
          const x = p % w;
          const y = (p - x) / w;
          if (x >= R.x0 - m && x < R.x1 + m && y >= R.y0 - m && y < R.y1 + m) {
            near.push(p);
            if (x >= R.x0 && x < R.x1 && y >= R.y0 && y < R.y1) insideCount++;
          }
        }
        if (!near.length) continue;
        const det = [];
        for (const p of near) if (D[p]) det.push(p);
        const box = boxOf(near, w);
        // the see-through strip it sits in, if any, along the nearest side
        // with no band (in R's lines, which cropFor's R starts from too only
        // when no band was cut: a strip is only looked for then)
        let strip = null;
        if (!bands.length) {
          const dist = { top: box.y0 - R.y0, bottom: R.y1 - box.y1, left: box.x0 - R.x0, right: R.x1 - box.x1 };
          const side = SIDES.reduce((a, b) => (dist[b] < dist[a] ? b : a));
          strip = markStrip(sigma, base, w, h, R, box, side, cfg);
        }
        marks.push({ kind: 'mark', pixels: Int32Array.from(near), detailPixels: Int32Array.from(det), box, strip });
      }
    }
    return { bands, marks, R, insideCount };
  }
}

// The region ids (indexes into the list a layout was made from) under these pixels.
function regionsOf(pixels, rl) {
  const out = new Set();
  for (const p of pixels) if (rl[p]) out.add(rl[p] - 1);
  return out;
}

function boxOf(pixels, w) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (const p of pixels) {
    const x = p % w;
    const y = (p - x) / w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

// Which overlay parts does this sample carry? Each overlay region is
// matched on its own pixels; a part is carried when the regions holding
// most of its pixels are. A plain region (no text or logo edges, such as a
// plain top bar) is matched on its colour alone, which a white sky or a dark
// ceiling in the same place matches too: it counts only for a photo that
// also carries a region with designed detail (the lettering that made the
// plain bar part of the overlay in the first place).
function carriedParts(tmpl, v, devRow, cfg) {
  const ok = new Set();
  let designed = false;
  for (const piece of tmpl.pieces) {
    const how = carries(tmpl, piece, v, devRow, cfg);
    if (!how) continue;
    ok.add(piece.rid);
    if (how === 'detail') designed = true;
  }
  if (!designed) return [];
  const out = [];
  for (const part of tmpl.parts) {
    let tot = 0;
    let got = 0;
    for (const { rid, c } of part.regions) {
      tot += c;
      if (ok.has(rid)) got += c;
    }
    if (tot && got >= cfg.matchParts * tot) out.push(part);
  }
  return out;
}

// Does this sample carry the region? Its colours match the template's at
// the region's steady pixels, and at its text and logo edges (or, for the
// lettering of a see-through band, the lettering stands out from the band
// beside it in this photo too). 'detail' when the edges were there to match,
// 'plain' when the region has too few of them and only its colour was
// matched, false when it is not carried.
function carries(tmpl, part, v, devRow, cfg) {
  const near = (p) => (devRow ? devRow[p] : maxDiff3(v.data, p * v.stride, tmpl.med, p * 3)) <= cfg.tol;
  // the part's steady pixels (the overlay itself) when there are enough of
  // them: pixels that only happened to agree (a dark corner, a white sky)
  // say nothing about whether this photo carries the overlay
  const px = part.corePixels.length >= cfg.detailMin ? part.corePixels : part.pixels;
  const det = part.corePixels.length >= cfg.detailMin ? part.coreDetail : part.detailPixels;
  let ok = 0;
  for (const p of px) if (near(p)) ok++;
  if (!px.length || ok < cfg.match * px.length) return false;
  if (det.length < Math.min(cfg.detailMin, px.length)) {
    const pairs = part.pairs || [];
    if (pairs.length / 2 < Math.min(cfg.detailMin, px.length)) return 'plain';
    const lum = (p) => (77 * v.data[p * v.stride] + 150 * v.data[p * v.stride + 1] + 29 * v.data[p * v.stride + 2] + 128) >> 8;
    let shown = 0;
    for (let i = 0; i < pairs.length; i += 2) if (Math.abs(lum(pairs[i]) - lum(pairs[i + 1])) * 2 >= cfg.detailContrast) shown++;
    return shown < (cfg.matchDetail * pairs.length) / 2 ? false : 'detail';
  }
  let okd = 0;
  for (const p of det) if (near(p)) okd++;
  return okd < cfg.matchDetail * det.length ? false : 'detail';
}


// ---------- the crop ----------

// The largest rectangle inside R that holds no obstacle pixel, keeps the
// photo's shape within the aspect factor and at least keepArea of the photo.
// Natural-pixel units for area and shape; grid units for the search. `clear`
// is the obstacle-free rectangle before it was narrowed to keep the shape.
function largestClear(obs, w, R, sx, sy, cfg, A0, minArea) {
  const cw = R.x1 - R.x0;
  if (cw <= 0 || R.y1 <= R.y0) return null;
  const heights = new Int32Array(cw);
  const stack = new Int32Array(cw + 1);
  const lo = A0 / cfg.aspect;
  const hi = A0 * cfg.aspect;
  const cx = (w * sx) / 2;
  let best = null;
  const consider = (ax0, ay0, ax1, ay1) => {
    let gw = ax1 - ax0;
    let gh = ay1 - ay0;
    let a = (gw * sx) / (gh * sy);
    let nx0 = ax0;
    let ny0 = ay0;
    if (a > hi) {
      const tw = Math.floor((gh * sy * hi) / sx);
      nx0 = ax0 + Math.floor((gw - tw) / 2);
      gw = tw;
    } else if (a < lo) {
      const th = Math.floor((gw * sx) / lo / sy);
      ny0 = ay0 + Math.floor((gh - th) / 2);
      gh = th;
    }
    if (gw <= 0 || gh <= 0) return;
    const area = gw * sx * gh * sy;
    if (area < minArea) return;
    const off = Math.abs((nx0 + gw / 2) * sx - cx);
    if (!best || area > best.area + 1e-6 || (Math.abs(area - best.area) <= 1e-6 && off < best.off)) best = { x0: nx0, y0: ny0, x1: nx0 + gw, y1: ny0 + gh, area, off, clear: { x0: ax0, y0: ay0, x1: ax1, y1: ay1 } };
  };
  for (let y = R.y0; y < R.y1; y++) {
    const row = y * w;
    for (let i = 0; i < cw; i++) heights[i] = obs && obs[row + R.x0 + i] ? 0 : heights[i] + 1;
    let sp = 0;
    for (let i = 0; i <= cw; i++) {
      const hgt = i < cw ? heights[i] : 0;
      while (sp && heights[stack[sp - 1]] >= hgt) {
        const top = stack[--sp];
        const hh = heights[top];
        if (!hh) continue;
        const left = sp ? stack[sp - 1] + 1 : 0;
        consider(R.x0 + left, y - hh + 1, R.x0 + i, y + 1);
      }
      stack[sp++] = i;
    }
  }
  return best;
}

// The crop for one photo from the parts it carries (in check-grid units).
function cropFor(grid, carried, W, H, cfg) {
  const { w, h } = grid;
  const sx = W / w;
  const sy = H / h;
  const R = { x0: 0, y0: 0, x1: w, y1: h };
  const bandSides = [];
  for (const b of carried.bands) {
    const cut = Math.max(0, b.cut);
    if (b.side === 'top') R.y0 = Math.max(R.y0, cut);
    else if (b.side === 'bottom') R.y1 = Math.min(R.y1, h - cut);
    else if (b.side === 'left') R.x0 = Math.max(R.x0, cut);
    else R.x1 = Math.min(R.x1, w - cut);
    if (!bandSides.includes(b.side)) bandSides.push(b.side);
  }
  const A0 = W / H;
  const minArea = cfg.keepArea * W * H;
  if (R.x1 - R.x0 < 2 || R.y1 - R.y0 < 2) return { status: 'kept', left: 'too-much' };
  // obstacles: every mark pixel inside R (or within the margin of it), grown by the margin
  const m = cfg.margin;
  const obstacles = (marks, strips) => {
    let obs = null;
    let count = 0;
    for (const mk of marks) {
      // the see-through strip the mark sits in, from the photo's edge
      const st = strips && mk.strip;
      if (st) {
        if (!obs) obs = new Uint8Array(w * h);
        const d = Math.min(sideDim(st.side, w, h), st.depth + m);
        for (let k = 0; k < d; k++) {
          if (st.side === 'top' || st.side === 'bottom') obs.fill(1, (st.side === 'top' ? k : h - 1 - k) * w, (st.side === 'top' ? k : h - 1 - k) * w + w);
          else for (let y = 0; y < h; y++) obs[y * w + (st.side === 'left' ? k : w - 1 - k)] = 1;
        }
      }
      for (const p of mk.pixels) {
        const x = p % w;
        const y = (p - x) / w;
        if (x < R.x0 - m || x >= R.x1 + m || y < R.y0 - m || y >= R.y1 + m) continue;
        if (!obs) obs = new Uint8Array(w * h);
        count++;
        for (let dy = -m; dy <= m; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -m; dx <= m; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < w) obs[yy * w + xx] = 1;
          }
        }
      }
    }
    return { obs, count };
  };
  const opaque = obstacles(carried.marks, false);
  // cutting edge bands removes overlay; stepping around a mark inside costs
  // photo, so that may take at most (1 - markKeep) of what the bands leave
  const open = largestClear(null, w, R, sx, sy, cfg, A0, minArea);
  const floor = open ? Math.max(minArea, cfg.markKeep * open.area) : Infinity;
  let rect = null;
  let left = null;
  // a mark in a see-through strip: the strip goes with it, when that keeps
  // as much as stepping around the mark may; else the mark is stepped
  // around as any other (the strip may then be the photo's own, such as a
  // sky that varies little)
  let strips = [];
  if (open && opaque.count && carried.marks.some((mk) => mk.strip)) {
    rect = largestClear(obstacles(carried.marks, true).obs, w, R, sx, sy, cfg, A0, floor);
    if (rect) strips = SIDES.filter((sd) => carried.marks.some((mk) => mk.strip && mk.strip.side === sd));
  }
  if (open && opaque.count && !rect) rect = largestClear(opaque.obs, w, R, sx, sy, cfg, A0, floor);
  if (!rect) {
    if (!open) return { status: 'kept', left: 'too-much' };
    if (opaque.count) {
      // the logo inside stays in the photo, which goes as the website shows it
      if (!bandSides.length) return { status: 'kept', left: 'inside' };
      left = 'inside';
    }
    rect = open;
  }
  // to natural pixels, rounding inward (the crop never reaches back into a
  // cut), and the floor checked again on what is actually sent. Whole-number
  // maths (grid line * natural size / grid size): (W / w) * w can come out a
  // hair under W, which would cut a line off an edge that had no band.
  const X0 = Math.min(W, Math.ceil((rect.x0 * W) / w));
  const Y0 = Math.min(H, Math.ceil((rect.y0 * H) / h));
  const X1 = Math.max(X0, Math.floor((rect.x1 * W) / w));
  const Y1 = Math.max(Y0, Math.floor((rect.y1 * H) / h));
  const crop = { x: X0, y: Y0, w: X1 - X0, h: Y1 - Y0 };
  if (crop.w <= 0 || crop.h <= 0 || crop.w * crop.h < minArea) return { status: 'kept', left: 'too-much' };
  if (crop.x === 0 && crop.y === 0 && crop.w === W && crop.h === H) return { status: 'kept', left: left || 'inside' };
  const sides = [];
  if (crop.y > 0) sides.push('top');
  if (crop.x + crop.w < W) sides.push('right');
  if (crop.y + crop.h < H) sides.push('bottom');
  if (crop.x > 0) sides.push('left');
  // a side with no band that was cut to step around a logo inside (rather
  // than only to keep the photo's shape), so the words name what came off it
  const stepped = rect !== open ? rect.clear : null;
  const inward = { top: (c) => c.y0 > R.y0, right: (c) => c.x1 < R.x1, bottom: (c) => c.y1 < R.y1, left: (c) => c.x0 > R.x0 };
  // a see-through strip cut with its mark is a band (lettered or not) on that side
  const stripSides = strips.filter((sd) => sides.includes(sd) && !bandSides.includes(sd));
  const markSides = stepped ? sides.filter((sd) => !bandSides.includes(sd) && !stripSides.includes(sd) && inward[sd](stepped)) : [];
  return { status: 'cropped', crop, sides, markSides, stripSides, left };
}


// ---------- the public check ----------

function blankEntry(p, status, reason) {
  const size = (v) => (Number.isFinite(v) ? v : null);
  return { status, crop: null, width: size(p.width), height: size(p.height), sides: [], bands: [], markSides: [], left: null, marks: 0, reason };
}

/**
 * Checks a car's photos for the website's overlay and works out crops.
 * photos: [{ id, width, height, w, h, rgba }] in the website's order; width
 * and height are the natural size (after EXIF orientation), w/h the check
 * size (checkSize), rgba w*h*4. A photo the caller could not read comes as
 * { id, reason } ('format' | 'decode' | 'download' | 'server' | 'slow') and
 * comes back unchecked with that reason. cover: the id of the website's cover
 * photo (default the first photo's), the one compared with other cars' covers.
 * lot: [{ key, width, height, w, h, rgb }] lotSample()s of OTHER cars' cover
 * photos from the same website (otherCovers).
 *
 * Returns { photos: { [id]: entry }, counts: { cropped, kept, none,
 * unchecked, inside } }, one entry per id:
 * { status, crop, width, height, sides, bands, markSides, left, marks, reason }
 * - 'cropped': crop is { x, y, w, h } in natural px, integers, inside the
 *   photo, keeping at least TUNING.keepArea of it; sides are the sides cut,
 *   bands the sides a band was found on, markSides the other sides cut to
 *   step around a logo inside (a corner logo); a side in neither was cut only
 *   to keep the photo's shape. left 'inside' when a logo found inside the
 *   photo is still in the crop (counted in counts.inside).
 * - 'kept': this photo carries the overlay but no crop takes it off within
 *   the limits: left 'inside' when a logo inside the photo can't be stepped
 *   around, 'too-much' when cutting the edge bands (a frame) would keep too
 *   little of the photo; crop is null.
 * - 'none': checked, and this photo carries none of the overlay found. That
 *   says nothing about see-through marks or logos on the car.
 * - 'unchecked': reason 'too-small', 'too-few', 'too-alike' or the caller's.
 * A photo that doesn't itself carry the overlay is never cropped.
 */
export function findBranding(photos, { lot = [], cover = undefined, tuning = null } = {}) {
  const cfg = tuning ? { ...TUNING, ...tuning } : TUNING;
  const list = Array.isArray(photos) ? photos : [];
  const result = { photos: {}, counts: { cropped: 0, kept: 0, none: 0, unchecked: 0, inside: 0 } };
  const groupsInfo = [];
  const seen = new Set();
  const usable = [];
  for (const p of list) {
    if (!p || p.id == null || seen.has(p.id)) continue;
    seen.add(p.id);
    if (p.reason != null) {
      result.photos[p.id] = blankEntry(p, 'unchecked', CALLER_REASONS.has(p.reason) ? p.reason : 'decode');
      continue;
    }
    const size = Number.isInteger(p.width) && Number.isInteger(p.height) ? checkSize(p.width, p.height) : null;
    if (!size) {
      result.photos[p.id] = blankEntry(p, 'unchecked', 'too-small');
      continue;
    }
    const data = p.rgba;
    if (!data || !ArrayBuffer.isView(data) || p.w !== size.w || p.h !== size.h || data.length !== size.w * size.h * 4) {
      // pixels that don't fit the size: the caller's decode went wrong
      result.photos[p.id] = blankEntry(p, 'unchecked', 'decode');
      continue;
    }
    usable.push({ ...p, v: view(data, 4) });
  }

  // same natural size, same pixel positions
  const groups = new Map();
  for (const p of usable) {
    const key = `${p.width}x${p.height}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const carried = new Map(); // id -> { bands: [], marks: [], checked, reason, grid }
  const note = (id) => {
    if (!carried.has(id)) carried.set(id, { bands: [], marks: [], checked: false, reason: null });
    return carried.get(id);
  };
  const describe = (tmpl) => tmpl.parts.map((p) => (p.kind === 'band' ? `${p.soft ? `soft${p.follow}-` : ''}band:${p.side}:d${p.depth}+e${p.ext}=${p.cut} s${p.shift.toFixed(1)}` : `mark@${p.box.x0},${p.box.y0}-${p.box.x1},${p.box.y1} s${p.shift.toFixed(1)}`));

  for (const [key, members] of groups) {
    const { w, h } = members[0];
    const P = w * h;
    const info = { size: key, photos: members.length, distinct: 0, status: null, parts: [] };
    groupsInfo.push(info);
    // distinct photos (a repeat or a re-saved copy counts once)
    const distinct = [];
    const twinOf = new Map();
    for (const p of members) {
      if (distinct.length >= MAX_CHECK_PHOTOS) break;
      const twin = distinct.find((d) => samePhoto(d.v, p.v, P, cfg));
      if (twin) twinOf.set(p.id, twin.id);
      else distinct.push(p);
    }
    info.distinct = distinct.length;
    if (distinct.length < MIN_PHOTOS) {
      // every one the same picture (a placeholder, one photo repeated): too
      // alike to tell; otherwise too few different photos to agree
      info.status = distinct.length === 1 && members.length > 1 ? 'too-alike' : 'too-few';
      for (const p of members) note(p.id).reason = info.status;
      continue;
    }
    const tmpl = analyse(distinct.map((d) => d.v), w, h, cfg);
    info.status = tmpl.status;
    info.stats = tmpl.stats;
    if (tmpl.status === 'too-alike') {
      for (const p of members) note(p.id).reason = 'too-alike';
      continue;
    }
    info.parts = describe(tmpl);
    tmpl.parts.forEach((part) => (part.uid = `${key}#${part.id}`));
    const index = new Map(distinct.map((d, i) => [d.id, i]));
    for (const p of members) {
      const c = note(p.id);
      c.checked = true;
      c.grid = { w, h };
      const src = index.has(p.id) ? p : members.find((m) => m.id === twinOf.get(p.id)) || p;
      const i = index.get(src.id);
      const devRow = i != null ? tmpl.dev.subarray(i * P, (i + 1) * P) : null;
      for (const part of carriedParts(tmpl, p.v, devRow && src === p ? devRow : null, cfg)) {
        if (part.kind === 'band') c.bands.push(part);
        else c.marks.push(part);
      }
    }
  }

  // the lot: this car's cover with other cars' covers of the same size
  const coverId = cover !== undefined ? cover : list[0] && list[0].id;
  const first = usable.find((p) => p.id === coverId); // the website's cover photo, when it could be checked
  if (first && Array.isArray(lot) && lot.length) {
    const ls = lotSample(first);
    const P = ls.w * ls.h;
    const pool = [view(ls.rgb, 3)];
    for (const e of lot) {
      if (!e || e.width !== first.width || e.height !== first.height || e.w !== ls.w || e.h !== ls.h) continue;
      if (!e.rgb || !ArrayBuffer.isView(e.rgb) || e.rgb.length !== P * 3) continue;
      const v = view(e.rgb, 3);
      if (pool.some((q) => samePhoto(q, v, P, cfg))) continue; // this car's cover again, or another car's repeat
      pool.push(v);
      if (pool.length >= COVER_SAMPLE_CARS + 1) break;
    }
    const info = { size: `${first.width}x${first.height}`, lot: true, photos: pool.length, distinct: pool.length, status: null, parts: [] };
    groupsInfo.push(info);
    if (pool.length >= MIN_PHOTOS) {
      const lcfg = scaled(cfg, Math.max(ls.w, ls.h) / CHECK_LONG_SIDE);
      const tmpl = analyse(pool, ls.w, ls.h, lcfg);
      info.status = tmpl.status;
      info.stats = tmpl.stats;
      if (tmpl.status === 'found') {
        info.parts = describe(tmpl);
        const same = usable.filter((p) => p.width === first.width && p.height === first.height);
        for (const p of same) {
          const lv = p === first ? ls : lotSample(p);
          const c = note(p.id);
          c.checked = true;
          c.grid = { w: p.w, h: p.h };
          for (const part of carriedParts(tmpl, view(lv.rgb, 3), null, lcfg)) {
            const mapped = toCheckGrid(part, ls.w, ls.h, p.w, p.h);
            mapped.uid = `lot#${part.id}`;
            if (mapped.kind === 'band') c.bands.push(mapped);
            else c.marks.push(mapped);
          }
        }
      } else if (tmpl.status === 'none') {
        const c = note(first.id);
        c.checked = true;
        c.grid = { w: first.w, h: first.h };
      }
    } else {
      info.status = 'too-few';
    }
  }

  // one entry per photo
  const crops = new Map();
  for (const p of usable) {
    const c = carried.get(p.id);
    if (!c || (!c.checked && !c.bands.length && !c.marks.length)) {
      result.photos[p.id] = blankEntry(p, 'unchecked', (c && c.reason) || 'too-few');
      continue;
    }
    const bands = dedupeBands(c.bands);
    const entry = blankEntry(p, 'none', null);
    entry.bands = SIDES.filter((s) => bands.some((b) => b.side === s));
    entry.marks = c.marks.length;
    if (bands.length || c.marks.length) {
      // photos of one size that carry the same parts get the same crop
      const key = `${p.width}x${p.height}|${[...bands, ...c.marks].map((x) => x.uid).sort().join(',')}`;
      let r = crops.get(key);
      if (!r) crops.set(key, (r = cropFor(c.grid || { w: p.w, h: p.h }, { bands, marks: c.marks }, p.width, p.height, cfg)));
      entry.status = r.status;
      entry.left = r.left;
      if (r.crop) {
        entry.crop = { ...r.crop };
        entry.sides = r.sides.slice();
        entry.markSides = r.markSides.slice();
        if (r.stripSides.length) entry.bands = SIDES.filter((sd) => entry.bands.includes(sd) || r.stripSides.includes(sd));
      }
    }
    result.photos[p.id] = entry;
  }
  for (const e of Object.values(result.photos)) {
    result.counts[e.status]++;
    if (e.status === 'cropped' && e.left === 'inside') result.counts.inside++;
  }
  if (cfg.debug) result.groups = groupsInfo; // what each group of photos found (tuning only)
  return result;
}

// A lot-grid part on a photo's check grid (the lot grid is half as fine, so
// cuts round outward and every lot pixel covers its whole block).
function toCheckGrid(part, lw, lh, w, h) {
  const fx = w / lw;
  const fy = h / lh;
  if (part.kind === 'band') {
    const f = part.side === 'top' || part.side === 'bottom' ? fy : fx;
    // reach: how deep on the check grid the overlay the lot saw may go. The
    // line past the band's last lot line (or its shadow) is not steady across
    // the covers, but it may still be overlay in all but its last check line.
    return { ...part, cut: Math.ceil(part.cut * f) + 1, reach: Math.ceil((part.depth + Math.max(part.ext, 1)) * f), lot: true };
  }
  const px = [];
  for (const p of part.pixels) {
    const x = p % lw;
    const y = (p - x) / lw;
    for (let yy = Math.floor(y * fy); yy < Math.min(h, Math.ceil((y + 1) * fy)); yy++) for (let xx = Math.floor(x * fx); xx < Math.min(w, Math.ceil((x + 1) * fx)); xx++) px.push(yy * w + xx);
  }
  const strip = part.strip ? { side: part.strip.side, depth: Math.ceil(part.strip.depth * (part.strip.side === 'top' || part.strip.side === 'bottom' ? fy : fx)) } : null;
  return { ...part, pixels: Int32Array.from(px), strip, lot: true };
}

// One band per side. The same band found in this car's photos and in the
// lot's covers: the car's cut (the finer grid, more photos) wins unless the
// overlay the lot's covers show may reach past it (more overlay on the cover,
// such as a strip over the band on covers only); then the lot's cut, which
// reaches past that, is taken.
function dedupeBands(bands) {
  const by = new Map();
  for (const b of bands) {
    const prev = by.get(b.side);
    if (!prev) by.set(b.side, b);
    else {
      const [own, lot] = prev.lot ? [b, prev] : [prev, b];
      if (own.lot || !lot.lot) by.set(b.side, prev.cut >= b.cut ? prev : b);
      else by.set(b.side, lot.reach > own.cut ? lot : own);
    }
  }
  return [...by.values()];
}

// ---------- the cover samples kept per website (coverSamples:<origin>) ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

function toBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[c & 63] : '=';
  }
  return out;
}

// null for anything that isn't plain, padded base64
function fromBase64(str) {
  if (typeof str !== 'string' || str.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(str)) return null;
  const pad = str.endsWith('==') ? 2 : str.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((str.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < str.length; i += 4) {
    const n = (B64_INDEX.get(str[i]) << 18) | (B64_INDEX.get(str[i + 1]) << 12) | ((B64_INDEX.get(str[i + 2]) || 0) << 6) | (B64_INDEX.get(str[i + 3]) || 0);
    if (o < out.length) out[o++] = n >> 16;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

const vinKey = (vin) => (typeof vin === 'string' ? vin.trim().toUpperCase() : '');
const posInt = (v) => Number.isInteger(v) && v > 0;
const lotSized = (w, h) => posInt(w) && posInt(h) && Math.max(w, h) <= LOT_LONG_SIDE;

// A stored car: { vin, at, width, height, w, h, data } with data the base64
// of exactly w*h*3 bytes. Its decoded pixels, or null when it is malformed.
function storedPixels(car) {
  if (!car || typeof car !== 'object' || !vinKey(car.vin) || typeof car.at !== 'string') return null;
  if (!posInt(car.width) || !posInt(car.height) || !lotSized(car.w, car.h)) return null;
  const rgb = fromBase64(car.data);
  return rgb && rgb.length === car.w * car.h * 3 ? rgb : null;
}

const storedCars = (stored) => (stored && typeof stored === 'object' && stored.version === 1 && Array.isArray(stored.cars) ? stored.cars : []);

/**
 * The next value of coverSamples:<origin> once this car's cover was checked:
 * { version: 1, cars: [{ vin, at, width, height, w, h, data }] }, this car
 * first, then the others newest first, one per VIN, at most
 * COVER_SAMPLE_CARS. data is the base64 of the cover's lotSample() (RGB, at
 * most LOT_LONG_SIDE across); sample may be that lotSample() or the cover's
 * check sample. A malformed stored value or car is dropped; a missing VIN or
 * an unusable sample leaves the (cleaned) stored cars as they were.
 */
export function withCover(stored, { vin, at, sample } = {}) {
  const others = storedCars(stored).filter((car) => storedPixels(car));
  const key = vinKey(vin);
  let small = sample && ArrayBuffer.isView(sample.rgb) ? sample : null;
  if (!small && sample && ArrayBuffer.isView(sample.rgba) && posInt(sample.w) && posInt(sample.h) && sample.rgba.length === sample.w * sample.h * 4) small = lotSample(sample);
  const when = typeof at === 'string' ? at : at instanceof Date || Number.isFinite(at) ? new Date(at).toISOString() : null;
  const ok = key && when && small && posInt(small.width) && posInt(small.height) && lotSized(small.w, small.h) && small.rgb.length === small.w * small.h * 3;
  const cars = ok ? [{ vin: vin.trim(), at: when, width: small.width, height: small.height, w: small.w, h: small.h, data: toBase64(small.rgb) }, ...others.filter((car) => vinKey(car.vin) !== key)] : others;
  return { version: 1, cars: cars.slice(0, COVER_SAMPLE_CARS) };
}

/**
 * The lot for findBranding: the stored covers of every car but this one
 * (VIN compared without case), newest first, as
 * [{ key, width, height, w, h, rgb }]; malformed entries (bad base64, wrong
 * length, missing size) are skipped.
 */
export function otherCovers(stored, vin) {
  const key = vinKey(vin);
  const out = [];
  for (const car of storedCars(stored)) {
    if (vinKey(car && car.vin) === key) continue;
    const rgb = storedPixels(car);
    if (rgb) out.push({ key: car.vin, width: car.width, height: car.height, w: car.w, h: car.h, rgb });
  }
  return out;
}

// ---------- what is sent ----------

// A crop that fits the photo it was worked out on: integers, inside it, not empty.
function fits(crop, width, height) {
  if (!crop || !posInt(width) || !posInt(height)) return false;
  const { x, y, w, h } = crop;
  return [x, y, w, h].every(Number.isInteger) && x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= width && y + h <= height;
}

const listed = (list, url) => (list instanceof Set ? list.has(url) : Array.isArray(list) && list.includes(url));

/**
 * What to cut from the photo at `url` before it goes into the form:
 * { x, y, w, h, width, height, sha } from a cropped entry (as the side panel
 * stored it, with the sha of the bytes it checked), or null when the photo
 * goes as the website shows it (not cropped, set back with Use original, or
 * an entry whose crop doesn't fit its photo).
 */
export function cropPlan(entry, { url, originals = [] } = {}) {
  if (!entry || entry.status !== 'cropped' || listed(originals, url)) return null;
  if (!fits(entry.crop, entry.width, entry.height)) return null;
  const { x, y, w, h } = entry.crop;
  return { x, y, w, h, width: entry.width, height: entry.height, sha: typeof entry.sha === 'string' && entry.sha ? entry.sha : null };
}

/**
 * True only when the photo about to be cropped is the one that was checked:
 * the same natural size and the same bytes (sha). A photo that changed on the
 * website since the check goes as the website shows it.
 */
export function matchesCheck(plan, { width, height, sha } = {}) {
  if (!plan || !plan.sha || typeof sha !== 'string') return false;
  return plan.sha === sha && plan.width === width && plan.height === height && fits(plan, width, height);
}

/**
 * The thumbnail's view of a cropped photo, for CSS object-view-box:
 * 'inset(t% r% b% l%)'. Each inset is rounded up to 0.1% of its side, so the
 * box shown never shows more than the crop sends and is at most 0.1% of a
 * side smaller. '' for an entry that is not cropped.
 */
export function insetOf(entry) {
  if (!entry || entry.status !== 'cropped' || !fits(entry.crop, entry.width, entry.height)) return '';
  const { x, y, w, h } = entry.crop;
  // tenths of a percent, rounded up: integer maths, so 25% of a side stays 25%
  const up = (cut, side) => Math.ceil((cut * 1000) / side) / 10;
  const t = up(y, entry.height);
  const r = up(entry.width - x - w, entry.width);
  const b = up(entry.height - y - h, entry.height);
  const l = up(x, entry.width);
  return `inset(${t}% ${r}% ${b}% ${l}%)`;
}

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif' };
const SAME_TYPE = { jpg: 'jpg', jpeg: 'jpg', jpe: 'jpg', png: 'png', webp: 'webp', avif: 'avif', gif: 'gif' };

/**
 * The file name with the extension that matches `type` (a cropped photo is
 * saved again, maybe in another format): 'photo-03.jpg' with image/png is
 * 'photo-03.png'. An extension that already matches is kept; an unknown type
 * leaves the name as it is.
 */
export function fileNameFor(name, type) {
  const base = typeof name === 'string' ? name : '';
  const ext = EXTENSIONS[String(type || '').toLowerCase().split(';')[0].trim()];
  if (!ext) return base;
  const m = base.match(/^(.*?)(?:\.([A-Za-z0-9]{1,5}))?$/);
  const stem = m[1];
  if (m[2] && SAME_TYPE[m[2].toLowerCase()] === ext) return base;
  return `${stem || 'photo'}.${ext}`;
}

// ---------- words for the side panel ----------

const SIDE_WORDS = { top: 'top', right: 'right side', bottom: 'bottom', left: 'left side' };

function sideList(sides) {
  const s = SIDES.filter((x) => (sides || []).includes(x)).map((x) => SIDE_WORDS[x]);
  if (s.length === 4) return 'all four edges';
  if (s.length <= 1) return 'the ' + (s[0] || 'edge');
  return 'the ' + s.slice(0, -1).join(', the ') + ' and the ' + s[s.length - 1];
}

// What was found: by how many sides carried a band.
function overlayWord(bands) {
  const n = (bands || []).length;
  return n >= 3 ? 'frame' : n === 2 ? 'logo bands' : n === 1 ? 'logo band' : 'corner logo';
}

// What came off which sides of a cropped photo: the band sides as a logo
// band (or bands, or a frame), the sides cut to step around a logo inside as
// a corner logo, and any other side as a strip cut to keep the photo's shape.
// "logo band off the bottom and a corner logo off the top". An entry saved
// before markSides existed counts its other sides as a corner logo's when it
// had one.
function cutSides(e) {
  const sides = SIDES.filter((x) => (e.sides || []).includes(x));
  const bands = sides.filter((x) => (e.bands || []).includes(x));
  const marks = sides.filter((x) => !bands.includes(x) && (Array.isArray(e.markSides) ? e.markSides.includes(x) : e.marks > 0));
  const shape = sides.filter((x) => !bands.includes(x) && !marks.includes(x));
  return { bands, marks, shape };
}
function cutPhrase(e) {
  const { bands, marks, shape } = cutSides(e);
  const parts = [];
  if (bands.length) parts.push(`${overlayWord(e.bands)} off ${sideList(bands)}`);
  if (marks.length) parts.push(`${parts.length ? 'a ' : ''}corner logo off ${sideList(marks)}`);
  if (shape.length) parts.push(`a strip off ${sideList(shape)} to keep the photo's shape`);
  if (!parts.length) return `${overlayWord(e.bands)} off the edges`;
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
// What a set-back photo keeps: the band word, and a corner logo too when one was stepped around.
function keptWord(e) {
  const { marks } = cutSides(e);
  const n = (e.bands || []).length;
  return n && marks.length ? `${overlayWord(e.bands)} and corner logo` : overlayWord(e.bands);
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

const WHY = {
  'too-small': 'too small to tell a logo from the picture',
  'too-few': `fewer than ${MIN_PHOTOS} different photos the same size`,
  'too-alike': 'too alike to tell a logo from the picture',
  format: "a picture format Lot Current can't read",
  decode: "couldn't be read",
  download: "couldn't be downloaded",
  server: "from a photo server Lot Current wasn't allowed to read",
  slow: 'took too long to download',
};
const whyOf = (entries) => [...new Set(entries.map((e) => WHY[e.reason] || 'the check ran without it'))].join('; ');

/**
 * One plain sentence (or a few) for the side panel about the photos with
 * these ids (the ones going on the listing). entries: the stored map
 * url -> entry; originals: the urls set back with Use original. Says what was
 * cropped and from which sides, how many still have a logo inside or could
 * not be cropped, how many were not checked and why, and how many the person
 * set back. It never says a photo is free of branding: the check only looks
 * for logo bands, frames and corner logos that repeat. '' with nothing to say.
 */
export function brandingSummary(entries, ids, { originals = [] } = {}) {
  if (!entries || typeof entries !== 'object' || !Array.isArray(ids) || !ids.length) return '';
  const total = ids.length;
  const all = ids.map((id) => ({ id, e: entries[id] || { status: 'unchecked', reason: null } }));
  const back = all.filter(({ id, e }) => e.status === 'cropped' && listed(originals, id)).map(({ e }) => e);
  const cropped = all.filter(({ id, e }) => e.status === 'cropped' && !listed(originals, id)).map(({ e }) => e);
  const kept = all.filter(({ e }) => e.status === 'kept').map(({ e }) => e);
  const unchecked = all.filter(({ e }) => e.status !== 'cropped' && e.status !== 'kept' && e.status !== 'none').map(({ e }) => e);
  const inside = cropped.filter((e) => e.left === 'inside').length;
  const them = (n) => (n === 1 ? 'it' : 'them');
  const out = [];
  if (cropped.length) {
    const phrases = new Set(cropped.map(cutPhrase));
    let what = [...phrases][0];
    if (phrases.size > 1) {
      // not cut the same way: say what came off, not from which sides
      const bands = [...new Set(cropped.flatMap((e) => e.bands || []))];
      const marked = cropped.some((e) => cutSides(e).marks.length);
      what = `${bands.length && marked ? `${overlayWord(bands)} and corner logo` : bands.length ? overlayWord(bands) : 'corner logo'} off the edges`;
    }
    out.push(`Cropped the same ${what} of ${cropped.length} of ${plural(total, 'photo')}.`);
    if (inside) out.push(`A logo is still inside ${inside === cropped.length ? (inside === 1 ? 'it' : 'all of them') : `${inside} of them`}.`);
  }
  if (back.length) {
    const words = [...new Set(back.map(keptWord))];
    out.push(`You set ${plural(back.length, 'photo')} back to the website's original, with the ${words.length === 1 ? words[0] : 'branding found'} left on.`);
  }
  if (kept.length) {
    const n = kept.length;
    out.push(`${cropped.length || back.length ? plural(n, 'more photo') : plural(n, 'photo')} ${n === 1 ? 'shows' : 'show'} the same logo where it can't be cropped off without losing too much of the photo, so ${n === 1 ? 'it goes' : 'they go'} on as the website shows ${them(n)}.`);
  }
  const found = cropped.length || back.length || kept.length;
  if (!found) {
    if (unchecked.length === total) {
      out.push(`Not checked for dealer branding (${whyOf(unchecked)}): ${total === 1 ? 'it goes' : 'they go'} on as the website shows ${them(total)}.`);
      return out.join(' ');
    }
    const n = total - unchecked.length;
    const across = unchecked.length ? `the ${plural(n, 'photo')} checked` : total === 1 ? 'this photo' : 'these photos';
    out.push(`Lot Current found no logo band, frame or corner logo repeating across ${across}; ${n === 1 ? 'it goes' : 'they go'} on as the website shows ${them(n)}.`);
  }
  if (unchecked.length) out.push(`${plural(unchecked.length, 'photo')} ${unchecked.length === 1 ? 'was' : 'were'} not checked (${whyOf(unchecked)}) and ${unchecked.length === 1 ? 'goes' : 'go'} on as the website shows ${them(unchecked.length)}.`);
  if (cropped.length) out.push('Check each one; Use original puts a photo back as the website shows it.');
  return out.join(' ');
}

const NOTE_WHY = {
  'too-small': 'too small',
  'too-few': 'too few photos this size',
  'too-alike': 'photos too alike',
  format: "format can't be read",
  decode: "couldn't be read",
  download: "couldn't be downloaded",
  server: 'photo server not allowed',
  slow: 'took too long',
};

/**
 * A short note for one photo in the side panel ('' for none): what was
 * cropped off ("Cropped: logo band off the bottom"), what the original keeps
 * when the person chose it ("Original: logo band left on"), a logo that
 * stays inside ("Logo still inside"), branding along the edges too deep to
 * crop off ("Frame left on: cropping it off would cut too much of the
 * photo") or why it was not checked ("Not checked: too small"). A photo
 * checked with nothing found gets '': nothing found is not the same as no
 * branding.
 */
export function photoNote(entry, { original = false } = {}) {
  if (!entry) return '';
  if (entry.status === 'cropped') {
    if (original) return `Original: ${keptWord(entry)} left on`;
    const base = `Cropped: ${cutPhrase(entry)}`;
    return entry.left === 'inside' ? `${base}; logo still inside` : base;
  }
  if (entry.status === 'kept') {
    if (entry.left === 'too-much') {
      const what = overlayWord(entry.bands);
      return `${what[0].toUpperCase()}${what.slice(1)} left on: cropping ${(entry.bands || []).length === 2 ? 'them' : 'it'} off would cut too much of the photo`;
    }
    return 'Logo still inside';
  }
  if (entry.status === 'unchecked') return `Not checked: ${NOTE_WHY[entry.reason] || 'not in the check'}`;
  return '';
}
