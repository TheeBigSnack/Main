// The browser half of the dealer-branding check (src/photoBranding.js holds
// the pure half): decodes a photo the service worker downloaded, hands its
// pixels to the check, and cuts the crop the check found. Runs only in the
// side panel (createImageBitmap, OffscreenCanvas, crypto.subtle); never
// injected into a page, and it never draws anything of its own.
//
// Crop only: the one picture this file makes to send is an exact
// sub-rectangle of the website's photo, copied with a single drawImage of
// that rectangle onto a canvas of the same size. Nothing is painted over,
// filled, blurred, filtered, blended or written on (test/photoHosts.test.js
// reads this file and fails on any other drawing call). The other canvas
// here is the small copy the check reads, which is never encoded or sent.

import { checkSize, matchesCheck } from './photoBranding.js';

// The formats Chrome decodes into pixels here. An SVG, a GIF (often animated)
// or a HEIC is not checked: it goes on as the website shows it.
const DECODED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
// A cropped photo is saved again in its own format where Chrome can write it,
// else (an AVIF) as a PNG: lossless and with any see-through pixels kept as
// they are, where a JPEG would fill them in black. Facebook compresses every
// upload again anyway.
const WRITTEN = new Set(['image/jpeg', 'image/png', 'image/webp']);
const FALLBACK = 'image/png';
const QUALITY = 0.92;

// "data:image/png;base64,...." -> { type, bytes }, decoded by hand (no fetch
// of the data: address); null for anything else.
function bytesOf(dataUrl) {
  const m = /^data:([^;,]+)((?:;[^;,]*)*?);base64,(.*)$/s.exec(typeof dataUrl === 'string' ? dataUrl : '');
  if (!m) return null;
  let raw;
  try {
    raw = atob(m[3]);
  } catch (e) {
    return null;
  }
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return { type: m[1].trim().toLowerCase(), bytes };
}

// The fingerprint of the bytes checked: a crop is cut only from these same bytes (matchesCheck).
async function shaOf(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// The picture the bytes hold, turned the way the photo's own orientation
// says (as a browser shows it): its size is the size every crop refers to.
const decode = (bytes, type) => createImageBitmap(new Blob([bytes], { type }), { imageOrientation: 'from-image' });

/**
 * One downloaded photo, read for the check: { ok: true, width, height, w,
 * h, rgba, sha, type } with rgba the photo drawn at checkSize (w x h), or
 * w = h = 0 and rgba null for a photo too small to check (findBranding says
 * so); { ok: false, reason: 'format' | 'decode' } for one it can't read.
 */
export async function samplePhoto(dataUrl) {
  const parsed = bytesOf(dataUrl);
  if (!parsed) return { ok: false, reason: 'decode' };
  if (!DECODED.has(parsed.type)) return { ok: false, reason: 'format' };
  let bitmap = null;
  try {
    const sha = await shaOf(parsed.bytes);
    bitmap = await decode(parsed.bytes, parsed.type);
    const { width, height } = bitmap;
    const size = checkSize(width, height);
    if (!size) return { ok: true, width, height, w: 0, h: 0, rgba: null, sha, type: parsed.type };
    const canvas = new OffscreenCanvas(size.w, size.h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, size.w, size.h); // the small copy the check reads; never encoded or sent
    const rgba = ctx.getImageData(0, 0, size.w, size.h).data;
    return { ok: true, width, height, w: size.w, h: size.h, rgba, sha, type: parsed.type };
  } catch (e) {
    return { ok: false, reason: 'decode' };
  } finally {
    if (bitmap) bitmap.close();
  }
}

// A Blob as a data: address, encoded by hand in chunks (no FileReader).
async function dataUrlOf(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let raw = '';
  for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type};base64,${btoa(raw)}`;
}

/**
 * The photo with the plan's rectangle cut out (src/photoBranding.js
 * cropPlan): { ok: true, dataUrl, type, width, height }, or { ok: false,
 * reason } when it is not cut: 'changed' when these are not the bytes that
 * were checked (the website changed the photo since), 'decode' when the
 * photo or the new file can't be made. The caller then sends the website's
 * photo as it is.
 */
export async function cropPhoto(dataUrl, plan) {
  const parsed = bytesOf(dataUrl);
  if (!parsed || !DECODED.has(parsed.type)) return { ok: false, reason: 'changed' };
  let bitmap = null;
  try {
    const sha = await shaOf(parsed.bytes);
    if (!plan || plan.sha !== sha) return { ok: false, reason: 'changed' }; // other bytes: not even decoded
    bitmap = await decode(parsed.bytes, parsed.type);
    if (!matchesCheck(plan, { width: bitmap.width, height: bitmap.height, sha })) return { ok: false, reason: 'changed' };
    const canvas = new OffscreenCanvas(plan.w, plan.h);
    canvas.getContext('2d').drawImage(bitmap, plan.x, plan.y, plan.w, plan.h, 0, 0, plan.w, plan.h);
    const blob = await canvas.convertToBlob({ type: WRITTEN.has(parsed.type) ? parsed.type : FALLBACK, quality: QUALITY });
    if (!blob || !blob.size || !/^image\//.test(blob.type)) return { ok: false, reason: 'decode' };
    return { ok: true, dataUrl: await dataUrlOf(blob), type: blob.type, width: plan.w, height: plan.h };
  } catch (e) {
    return { ok: false, reason: 'decode' };
  } finally {
    if (bitmap) bitmap.close();
  }
}
