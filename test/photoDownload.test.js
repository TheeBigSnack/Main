// The service worker's photo download (background.js downloadPhoto), run
// under Node with a fake fetch: any https server the salesperson allows can
// be reached now, so a photo is capped in size before and while it is read,
// capped in time from the request to the last byte, and never fetched from
// Facebook's own servers, whatever the manifest would allow.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// The worker registers its listeners when it loads; these stubs only take them.
const listeners = { addListener() {} };
globalThis.chrome = { alarms: { onAlarm: listeners }, runtime: { onMessage: listeners, onInstalled: listeners, onStartup: listeners } };
const { downloadPhoto, sniffPhotoType, MAX_PHOTO_BYTES, PHOTO_TIMEOUT_MS } = await import('../extension/background.js');

const MB = 1024 * 1024;
// Every test here must end on its own well inside this; a hang is a failure, not a stuck run.
const LIMIT = { timeout: 5000 };

// A body sent in 1 MB chunks, counting how many the reader pulled.
function chunkedBody(chunks, { stallAfter = Infinity } = {}) {
  const counter = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(MB).fill(0xff);
  const stream = new ReadableStream({
    pull(controller) {
      if (counter.pulled >= stallAfter) return new Promise(() => {}); // the server stops sending, the connection stays open
      if (counter.pulled >= chunks) return controller.close();
      counter.pulled += 1;
      controller.enqueue(chunk);
      return undefined;
    },
    cancel() {
      counter.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, counter };
}

test('a small photo comes back as a data URL with its size and a numbered name', LIMIT, async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  let asked;
  const fetchImpl = async (url, init) => {
    asked = init;
    return new Response(bytes, { headers: { 'content-type': 'image/png; charset=binary' } });
  };
  const r = await downloadPhoto('https://img.cdn.example/1.png', 2, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.name, 'photo-03.png');
  assert.equal(r.type, 'image/png');
  assert.equal(r.bytes, bytes.length);
  assert.equal(r.dataUrl, 'data:image/png;base64,' + Buffer.from(bytes).toString('base64'));
  assert.equal(asked.credentials, 'omit', 'no cookies go with a photo request');
  assert.ok(asked.signal instanceof AbortSignal, 'every request can be cut off');
});

test('a photo that says it is too large is not read at all', LIMIT, async () => {
  const { stream, counter } = chunkedBody(200);
  const fetchImpl = async () => new Response(stream, { headers: { 'content-type': 'image/jpeg', 'content-length': String(MAX_PHOTO_BYTES + 1) } });
  const started = Date.now();
  const r = await downloadPhoto('https://huge.example/x.jpg', 0, { fetchImpl });
  assert.deepEqual([r.ok, r.error], [false, 'too large (huge.example)']);
  assert.equal(counter.pulled, 0, 'not one chunk of the body was pulled');
  assert.ok(Date.now() - started < 1000);
});

test('a body larger than the cap, with no length given, is cut off just past the cap', LIMIT, async () => {
  const { stream, counter } = chunkedBody(200); // 200 MB if it were read to the end
  const fetchImpl = async () => new Response(stream, { headers: { 'content-type': 'image/jpeg' } });
  const started = Date.now();
  const r = await downloadPhoto('https://huge.example/x.jpg', 0, { fetchImpl });
  assert.deepEqual([r.ok, r.error], [false, 'too large (huge.example)']);
  assert.ok(counter.pulled <= MAX_PHOTO_BYTES / MB + 2, `stopped reading after ${counter.pulled} MB`);
  assert.equal(counter.cancelled, true, 'the rest of the body is cancelled');
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test('a server that never answers fails the photo after the timeout, naming the server', LIMIT, async () => {
  assert.equal(PHOTO_TIMEOUT_MS, 30000);
  let signal;
  const fetchImpl = (url, init) => {
    signal = init.signal;
    return new Promise(() => {}); // not even headers
  };
  const started = Date.now();
  const r = await downloadPhoto('https://slow.example/x.jpg', 0, { fetchImpl, timeoutMs: 50 });
  assert.equal(r.ok, false);
  assert.match(r.error, /^slow\.example: no complete answer in/);
  assert.equal(signal.aborted, true, 'the request itself is aborted');
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test('a body that stops arriving fails the photo after the timeout', LIMIT, async () => {
  const { stream, counter } = chunkedBody(200, { stallAfter: 2 });
  const fetchImpl = async () => new Response(stream, { headers: { 'content-type': 'image/jpeg' } });
  const started = Date.now();
  const r = await downloadPhoto('https://slow.example/x.jpg', 0, { fetchImpl, timeoutMs: 50 });
  assert.equal(r.ok, false);
  assert.match(r.error, /^slow\.example: no complete answer in/);
  assert.equal(counter.cancelled, true, 'the stalled body is cancelled');
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test('a batch with one stalled server still answers, with the other photos', LIMIT, async () => {
  const fetchImpl = (url) => (url.includes('slow') ? new Promise(() => {}) : Promise.resolve(new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } })));
  const urls = ['https://a.example/1.jpg', 'https://slow.example/2.jpg', 'https://a.example/3.jpg'];
  const photos = await Promise.all(urls.map((u, i) => downloadPhoto(u, i, { fetchImpl, timeoutMs: 50 })));
  assert.deepEqual(photos.map((p) => p.ok), [true, false, true]);
});

test('never from Facebook\'s own servers, even ones the manifest covers: nothing is requested', LIMIT, async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 1]), { headers: { 'content-type': 'image/jpeg' } });
  };
  for (const url of [
    'https://www.facebook.com/marketplace/photo.jpg',
    'https://scontent-iad3-1.xx.fbcdn.net/v/1.jpg',
    'https://lookaside.fbsbx.com/a.jpg',
    'https://static.xx.fbcdn.net/b.png',
    'https://connect.facebook.net/c.jpg',
    'https://www.fb.com/d.jpg',
    'http://scontent.fbcdn.net/e.jpg',
  ]) {
    const r = await downloadPhoto(url, 0, { fetchImpl });
    assert.equal(r.ok, false, url);
    assert.match(r.error, /Facebook/, url);
  }
  assert.equal(calls, 0, 'no request went out');
  assert.equal((await downloadPhoto('https://notfbcdn.net/ok.jpg', 0, { fetchImpl })).ok, true, 'a name that only ends the same way is not Facebook');
});

test('a 200 answer that is not a photo is a photo that couldn\'t be downloaded, never one attached as .jpg', LIMIT, async () => {
  const page = new TextEncoder().encode('<!doctype html><html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>');
  const answer = (body, type) => async () => new Response(body, type === null ? {} : { headers: { 'content-type': type } });
  const html = await downloadPhoto('https://img.cdn.example/1.jpg', 0, { fetchImpl: answer(page, 'text/html; charset=utf-8') });
  assert.deepEqual(html, { url: 'https://img.cdn.example/1.jpg', ok: false, error: 'not a photo (text/html) from img.cdn.example' });
  // the same page under an image type, or with no type at all
  assert.deepEqual([(await downloadPhoto('https://img.cdn.example/2.jpg', 0, { fetchImpl: answer(page, 'image/jpeg') })).ok], [false]);
  assert.equal((await downloadPhoto('https://img.cdn.example/3.jpg', 0, { fetchImpl: answer(page, null) })).error, 'not a photo (no type given) from img.cdn.example');
  assert.equal((await downloadPhoto('https://img.cdn.example/4.jpg', 0, { fetchImpl: answer(new TextEncoder().encode('{"error":"not found"}'), 'application/json') })).ok, false);
});

test('a photo is known by its bytes: a JPEG served as octet-stream or with no type still attaches, under its real type', LIMIT, async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50]);
  const answer = (body, type) => async () => new Response(body, type === null ? {} : { headers: { 'content-type': type } });
  const s3 = await downloadPhoto('https://bucket.s3.example/a', 0, { fetchImpl: answer(jpeg, 'binary/octet-stream') });
  assert.deepEqual([s3.ok, s3.name, s3.type], [true, 'photo-01.jpg', 'image/jpeg']);
  assert.match(s3.dataUrl, /^data:image\/jpeg;base64,/);
  const bare = await downloadPhoto('https://bucket.s3.example/b', 1, { fetchImpl: answer(webp, null) });
  assert.deepEqual([bare.ok, bare.name, bare.type], [true, 'photo-02.webp', 'image/webp']);
  const mislabelled = await downloadPhoto('https://img.cdn.example/c.jpg', 2, { fetchImpl: answer(png, 'image/jpeg') });
  assert.deepEqual([mislabelled.ok, mislabelled.name, mislabelled.type], [true, 'photo-03.png', 'image/png']);
  // a format the bytes check doesn't know is believed when the server calls it an image (an SVG photo as the demo serves)
  const svg = await downloadPhoto('https://img.cdn.example/d.svg', 3, { fetchImpl: answer(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml') });
  assert.deepEqual([svg.ok, svg.type], [true, 'image/svg+xml']);
  assert.equal(sniffPhotoType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'image/gif');
  assert.equal(sniffPhotoType(new Uint8Array([1, 2, 3])), null);
  assert.equal(sniffPhotoType(new Uint8Array(0)), null);
});

test('an empty body, or one that is not the photo its type names, is a photo that couldn\'t be downloaded', LIMIT, async () => {
  const answer = (text, type) => async () => new Response(new TextEncoder().encode(text), { headers: { 'content-type': type } });
  for (const [text, type] of [['', 'image/jpeg'], ['', 'image/svg+xml'], ['{"error":"not found"}', 'image/jpeg'], ['Not Found', 'image/png'], ['Not Found', 'image/webp'], ['<!doctype html><html><body>Checking your browser</body></html>', 'image/svg+xml']]) {
    const r = await downloadPhoto('https://img.cdn.example/1.jpg', 0, { fetchImpl: answer(text, type) });
    assert.deepEqual([r.ok, r.error], [false, `not a photo (${type}) from img.cdn.example`], `${JSON.stringify(text)} under ${type}`);
  }
  // an SVG drawing is still one, named as one; an AVIF photo is known by its bytes, with or without a type
  const svg = await downloadPhoto('https://img.cdn.example/d.svg', 3, { fetchImpl: answer('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'image/svg+xml') });
  assert.deepEqual([svg.ok, svg.name, svg.type], [true, 'photo-04.svg', 'image/svg+xml']);
  const avif = new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0, 0, 0]);
  for (const type of [null, 'image/avif', 'application/octet-stream']) {
    const r = await downloadPhoto('https://img.cdn.example/e', 4, { fetchImpl: async () => new Response(avif, type ? { headers: { 'content-type': type } } : {}) });
    assert.deepEqual([r.ok, r.name, r.type], [true, 'photo-05.avif', 'image/avif'], `AVIF under ${type}`);
  }
  assert.equal(sniffPhotoType(avif), 'image/avif');
  // a format the bytes check doesn't know, under its own image type, keeps its name
  const heic = await downloadPhoto('https://img.cdn.example/f', 5, { fetchImpl: async () => new Response(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]), { headers: { 'content-type': 'image/heic' } }) });
  assert.deepEqual([heic.ok, heic.name, heic.type], [true, 'photo-06.heic', 'image/heic']);
});
