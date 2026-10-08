// The side panel's dealer-branding check of a car's photos, run as written
// (sidepanel.js checkBranding, readForBranding, stopBranding,
// brandingAfterSettings, forTheForm, photoPickHtml, brandingHtml, photosHtml,
// startFlow), with src/photoBranding.js's own helpers and the rest of the
// panel replaced by stubs (the way panelFlow.test.js runs the panel):
//   - the check reads the car's photos in batches of four through the
//     service worker, only from servers Chrome already allows, only in the
//     post's own window when it runs by itself, and within a time limit;
//   - a post dropped, a check skipped or another car on screen takes
//     nothing from a check still running;
//   - it keeps a small sample of the website's cover photo, only when the
//     cover was read with the setting on;
//   - a photo goes into the form (and the Downloads folder) cropped only
//     with the setting on, when the person did not set it back, and when its
//     bytes are the ones checked; otherwise as the website shows it;
//   - the thumbnail shows exactly the crop that goes, with Use original;
//   - a queued car's form waits for the check, and a car whose photos were
//     cropped waits at review.
// The decode and the cut (src/photoCanvas.js) are stand-ins here
// (test/photoCanvas.test.js and test/e2e/branding.e2e.mjs hold those): a
// "photo" is its address, and findBranding is told which addresses carry
// the overlay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withCover, otherCovers, lotSample, cropPlan, matchesCheck, fileNameFor, brandingSummary, photoNote, insetOf, MAX_CHECK_PHOTOS } from '../extension/src/photoBranding.js';
import { usablePhotos, settlePick, pickSummary } from '../extension/src/photoPick.js';
import { isFacebookServer } from '../extension/src/photoHosts.js';
import { updateKey } from '../extension/src/storage.js';
import { FORM_MAP } from '../extension/facebook/formMap.js';
import { relistNotice } from '../extension/src/takenDown.js';

const src = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
// A top-level function's text, from its declaration to the closing brace at the start of a line.
function fnText(name) {
  const start = src.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} is defined`);
  return src.slice(start, src.indexOf('\n}\n', start) + 2);
}
// A top-level one-line const as written.
function constText(name) {
  const m = src.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  assert.ok(m, `${name} is defined`);
  return m[0];
}
// Several functions compiled in one scope, so they call each other as written.
function compileMany(names, scope, consts = []) {
  const keys = Object.keys(scope);
  return new Function(...keys, `${consts.map(constText).join('\n')}\n${names.map(fnText).join('\n')}\nreturn { ${names.join(', ')} };`)(...keys.map((k) => scope[k]));
}

const ORIGIN = 'https://www.example-motors.test';
const PHOTOS = [1, 2, 3, 4, 5, 6].map((n) => `https://img.example.test/a/${n}.jpg`);
const COVER_KEY = 'coverSamples:' + ORIGIN;
const entry = (status, extra = {}) => ({ status, crop: status === 'cropped' ? { x: 0, y: 0, w: 640, h: 432 } : null, width: 640, height: 480, sides: status === 'cropped' ? ['bottom'] : [], bands: status === 'cropped' ? ['bottom'] : [], left: null, marks: 0, reason: null, ...extra });
// the worker's answer for a photo: its bytes stand for its address and a version (the website changing the photo)
const file = (url, version = 1) => ({ url, ok: true, name: `photo-0${PHOTOS.indexOf(url) + 1}.jpg`, type: 'image/jpeg', dataUrl: `data:image/jpeg;base64,${Buffer.from(`${url}#${version}`).toString('base64')}` });
const bytesOf = (dataUrl) => Buffer.from(dataUrl.split(',')[1], 'base64').toString();
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
// a finished check of car AAA as the panel keeps it: the photos given carry a crop
const checked = (cropped, vin = 'AAA') => ({ version: 1, vin, checkedAt: '2026-10-08T12:00:00.000Z', lot: 0, photos: Object.fromEntries(PHOTOS.map((u) => [u, { ...entry(cropped.includes(u) ? 'cropped' : 'none'), sha: `sha-${u}-1`, type: 'image/jpeg' }])) });

// hold: each download waits for the test (held); timeUp: the check's time limit has already run out
function panel({ photos = PHOTOS, overlay = [], hold = false, own = true, settings = { cropBranding: true }, step = 'review', stored = {}, allowed = () => true, timeUp = false } = {}) {
  const calls = [];
  const sent = [];
  const held = [];
  const store = JSON.parse(JSON.stringify(stored));
  const state = { origin: ORIGIN, vin: 'AAA', step, vehicle: { vin: 'AAA', name: '2020 Make Model A', photos }, settings, branding: null, photoOriginals: null, brandingRun: null, photoPick: null, fill: null, map: { photoLimitDefault: 20 } };
  const answer = (msg) => ({ ok: true, photos: msg.urls.map((u) => file(u)) });
  const local = { get: async (k) => ({ [k]: store[k] }), set: async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); } };
  const scope = {
    state, flowRun: 0, watcher: null, FORM_MAP,
    chrome: {
      runtime: {
        sendMessage: (msg) => {
          calls.push(`download ${msg.urls.length}`);
          sent.push(...msg.urls);
          return hold ? new Promise((resolve) => held.push(() => resolve(answer(msg)))) : Promise.resolve(answer(msg));
        },
      },
      storage: { local },
    },
    postsWindow: () => own, isFacebookServer, usablePhotos, MAX_CHECK_PHOTOS,
    photoPatterns: (urls) => [...new Set(urls.filter((u) => !allowed(u)).map((u) => new URL(u).origin + '/' + '*'))],
    patternCovers: (p, u) => !allowed(u) && u.startsWith(p.slice(0, -1)),
    sleep: () => (timeUp ? Promise.resolve() : new Promise(() => {})),
    samplePhoto: async (dataUrl) => {
      const [url, version] = bytesOf(dataUrl).split('#');
      calls.push(`sample ${PHOTOS.indexOf(url) + 1}`);
      return { ok: true, width: 640, height: 480, w: 256, h: 192, rgba: new Uint8ClampedArray(256 * 192 * 4), sha: `sha-${url}-${version}`, type: 'image/jpeg' };
    },
    // the check: the photos it was told about carry the overlay along the bottom
    findBranding: (list, opts) => {
      calls.push(`findBranding lot ${opts.lot.length} cover ${PHOTOS.indexOf(opts.cover) + 1}`);
      const out = { photos: {}, counts: { cropped: 0, kept: 0, none: 0, unchecked: 0, inside: 0 } };
      for (const p of list) {
        const e = p.reason ? entry('unchecked', { reason: p.reason }) : entry(overlay.includes(p.id) ? 'cropped' : 'none');
        out.photos[p.id] = e;
        out.counts[e.status] += 1;
      }
      return out;
    },
    otherCovers, withCover, lotSample, updateKey, coverStorage: local,
    siteKeys: (o) => ({ coverSamples: 'coverSamples:' + o, flow: 'postFlow:' + o }),
    cropPlan, fileNameFor, brandingSummary,
    // the cut: refused unless the bytes are the ones checked, as photoCanvas.js refuses
    cropPhoto: async (dataUrl, plan) => {
      const [url, version] = bytesOf(dataUrl).split('#');
      calls.push(`crop ${PHOTOS.indexOf(url) + 1}`);
      if (!matchesCheck(plan, { width: 640, height: 480, sha: `sha-${url}-${version}` })) return { ok: false, reason: 'changed' };
      return { ok: true, dataUrl: `data:image/png;base64,${Buffer.from(`cropped ${url}`).toString('base64')}`, type: 'image/png', width: plan.w, height: plan.h };
    },
    pickedPhotos: () => usablePhotos(state.vehicle.photos),
    redrawPhotos: () => calls.push('redraw'), $: () => null,
    setStatus: (text) => calls.push(`status: ${text}`), saveFlow: async (opts) => { calls.push(`save${opts && opts.quiet ? ' quiet' : ''}`); },
    pilotNote: async () => {}, endPost: () => {}, dropSavedFlow: async () => {},
  };
  const fns = compileMany(['checkBranding', 'readForBranding', 'stopBranding', 'forTheForm', 'brandingAfterSettings', 'brandingEntry', 'clearFlow'], scope,
    ['brandingOn', 'brandingUrls', 'brandingNow', 'setBack', 'goesCropped', 'BRANDING_TIME_LIMIT_MS', 'brandingProgressText']);
  return { state, calls, sent, held, store, fns };
}

test('the photo check reads the car\'s photos in batches of four, keeps what it found with the post, and keeps a sample of the cover for the next cars', async () => {
  const p = panel({ overlay: PHOTOS.slice(0, 5) });
  const running = p.fns.checkBranding(); // Check again, clicked
  assert.deepEqual(p.state.brandingRun, { done: 0, total: 6, stopped: false }, 'marked as under way before anything is awaited');
  await running;
  assert.equal(p.state.brandingRun, null);
  assert.deepEqual(p.calls.filter((c) => c.startsWith('download')), ['download 4', 'download 2']);
  assert.deepEqual(p.sent, PHOTOS);
  assert.ok(p.calls.includes('findBranding lot 0 cover 1'), 'the website\'s first photo is the cover');
  const b = p.state.branding;
  assert.deepEqual([b.version, b.vin, b.lot, typeof b.checkedAt], [1, 'AAA', 0, 'string']);
  assert.deepEqual(Object.keys(b.photos), PHOTOS);
  assert.deepEqual(Object.values(b.photos).map((e) => e.status), ['cropped', 'cropped', 'cropped', 'cropped', 'cropped', 'none']);
  assert.deepEqual([b.photos[PHOTOS[0]].sha, b.photos[PHOTOS[0]].type], [`sha-${PHOTOS[0]}-1`, 'image/jpeg'], 'each entry keeps the fingerprint and type of the bytes it was worked out on');
  // the cover's sample, for the next cars of this website: this car's VIN, at most 128 pixels across, RGB
  const kept = p.store[COVER_KEY];
  assert.deepEqual(kept.cars.map((c) => [c.vin, c.w, c.h, c.width, c.height]), [['AAA', 128, 96, 640, 480]]);
  assert.equal(otherCovers(kept, 'AAA').length, 0, 'never this car\'s own lot');
  assert.equal(otherCovers(kept, 'BBB')[0].rgb.length, 128 * 96 * 3, 'the next car compares with it');
  // a check the person asked for says its result, and is saved without a not-saved screen
  assert.match(p.calls.find((c) => c.startsWith('status: ')), /^status: Cropped the same logo band off the bottom of 5 of 6 photos\./);
  assert.equal(p.calls[p.calls.length - 1], 'save quiet');

  // the next car of the same website gets this one's cover as its lot
  const q = panel({ stored: p.store });
  q.state.vin = 'BBB';
  q.state.vehicle.vin = 'BBB';
  await q.fns.checkBranding({ auto: true });
  assert.ok(q.calls.includes('findBranding lot 1 cover 1'), q.calls.join(' | '));
  assert.deepEqual(q.store[COVER_KEY].cars.map((c) => c.vin), ['BBB', 'AAA'], 'newest first');
  assert.ok(!q.calls.some((c) => c.startsWith('status: ')), 'an automatic check that found nothing says nothing');
  // an automatic one that found something says so, but never over another message
  const r = panel({ overlay: PHOTOS });
  await r.fns.checkBranding({ auto: true });
  assert.ok(r.calls.some((c) => c.startsWith('status: Cropped')), 'with the status line empty it is said');
});

test('the person\'s Use original stays through a check again of the same photos, for the photos it still crops', async () => {
  const p = panel({ overlay: PHOTOS.slice(0, 3) });
  p.state.photoOriginals = [PHOTOS[0], PHOTOS[4]];
  await p.fns.checkBranding();
  assert.deepEqual(p.state.photoOriginals, [PHOTOS[0]], 'a photo the check no longer crops has nothing to set back');
  const none = panel({ overlay: [] });
  none.state.photoOriginals = [PHOTOS[0]];
  await none.fns.checkBranding();
  assert.equal(none.state.photoOriginals, null);
});

test('a post dropped, a check skipped or another car on screen while the photo check runs takes nothing from it', async () => {
  // dropped (Stop, Back, a new post: clearFlow) while the first batch downloads
  const p = panel({ hold: true, overlay: PHOTOS });
  const running = p.fns.checkBranding({ auto: true });
  await settle();
  await p.fns.clearFlow();
  assert.equal(p.state.brandingRun, null, 'clearFlow lets the check go');
  p.held.shift()();
  await running;
  await settle();
  assert.equal(p.state.branding, null, 'nothing lands in the post that took over');
  assert.deepEqual(p.calls.filter((c) => c.startsWith('download')), ['download 4'], 'no second batch');
  assert.deepEqual(p.calls.filter((c) => c === 'redraw'), ['redraw'], 'only the redraw that showed the check starting');
  assert.ok(!p.calls.some((c) => /^(sample|findBranding|status|save)/.test(c)), p.calls.join(' | '));
  assert.equal(p.store[COVER_KEY], undefined, 'no cover sample is kept');

  // Skip the check: let go at once, and an earlier finished check of this car stays as it was
  const s = panel({ hold: true, overlay: PHOTOS });
  const earlier = checked([PHOTOS[0]]);
  s.state.branding = earlier;
  const skipped = s.fns.checkBranding();
  await settle();
  assert.equal(s.fns.stopBranding(), true);
  assert.equal(s.state.brandingRun, null, 'the form buttons come on at once');
  assert.equal(s.fns.stopBranding(), false, 'nothing left to stop');
  s.held.shift()();
  await skipped;
  await settle();
  assert.equal(s.state.branding, earlier);
  assert.ok(!s.calls.some((c) => /^(sample|findBranding|status|save)/.test(c)), s.calls.join(' | '));
  assert.equal(s.store[COVER_KEY], undefined);

  // another car on screen (a queue moved on) when the answer comes
  const o = panel({ hold: true, overlay: PHOTOS });
  const late = o.fns.checkBranding({ auto: true });
  await settle();
  o.state.vin = 'BBB';
  o.held.shift()();
  await late;
  assert.equal(o.state.branding, null);
  assert.ok(!o.calls.some((c) => /^(findBranding|save)/.test(c)));
});

test('a check whose review was left (the form opening) takes nothing from it, and none starts while the form opens', async () => {
  // the form starts opening while a batch downloads (a way round the buttons being off): the crop the person never saw is dropped
  const p = panel({ hold: true, overlay: PHOTOS });
  const running = p.fns.checkBranding();
  await settle();
  p.state.opening = true;
  p.held.shift()();
  await running;
  await settle();
  assert.equal(p.state.branding, null);
  assert.ok(!p.calls.some((c) => /^(sample|findBranding|status|save)/.test(c)), p.calls.join(' | '));
  // or the step moves on before the answers come: still nothing lands
  const q = panel({ overlay: PHOTOS });
  const moved = q.fns.checkBranding();
  q.state.step = 'filling';
  await moved;
  assert.equal(q.state.branding, null);
  // Check again while the form opens does nothing
  const r = panel({ overlay: PHOTOS });
  r.state.opening = true;
  await r.fns.checkBranding();
  assert.equal(r.state.brandingRun, null);
  assert.deepEqual(r.calls, []);
});

test('the automatic photo check runs only in the post\'s own window, with the setting on, at review, once, and reads only servers Chrome already allows', async () => {
  for (const [what, opts] of [['a second window', { own: false }], ['the setting off', { settings: { cropBranding: false } }], ['no settings read yet', { settings: null }], ['not at review', { step: 'publish' }], ['no photos', { photos: [] }]]) {
    const p = panel(opts);
    await p.fns.checkBranding({ auto: true });
    assert.deepEqual([p.sent, p.state.branding, p.state.brandingRun], [[], null, null], what);
  }
  // Check again in a second window is the person's own click: it runs there
  const click = panel({ own: false });
  await click.fns.checkBranding();
  assert.equal(click.sent.length, 6);
  // one at a time: a second start while one runs does nothing
  const twice = panel({ hold: true });
  const first = twice.fns.checkBranding({ auto: true });
  await twice.fns.checkBranding({ auto: true });
  await twice.fns.checkBranding();
  await settle();
  assert.deepEqual(twice.calls.filter((c) => c.startsWith('download')), ['download 4']);
  while (twice.held.length) { twice.held.shift()(); await settle(); }
  await first;
  // a car with a finished check is not checked again by a panel brought back or a setting turned on (onlyIfNone)
  const again = panel();
  again.state.branding = checked([]);
  await again.fns.checkBranding({ auto: true, onlyIfNone: true });
  assert.deepEqual(again.sent, []);
  again.state.branding = checked([], 'OTHER'); // another car's check, saved before: this car has none
  await again.fns.checkBranding({ auto: true, onlyIfNone: true });
  assert.equal(again.sent.length, 6);
  // at most MAX_CHECK_PHOTOS photos, never one on Facebook's servers
  const many = Array.from({ length: MAX_CHECK_PHOTOS + 5 }, (_, i) => `https://img.example.test/m/${i}.jpg`);
  const big = panel({ photos: ['https://scontent.xx.fbcdn.net/v/0.jpg', ...many] });
  await big.fns.checkBranding({ auto: true });
  assert.deepEqual(big.sent, many.slice(0, MAX_CHECK_PHOTOS));

  // a photo server Chrome would have to ask about is not read (only a click asks); the cover not read means no cover sample
  const blocked = panel({ allowed: (u) => !u.endsWith('/1.jpg') });
  await blocked.fns.checkBranding({ auto: true });
  assert.deepEqual(blocked.sent, PHOTOS.slice(1));
  assert.equal(blocked.state.branding.photos[PHOTOS[0]].reason, 'server');
  assert.equal(blocked.store[COVER_KEY], undefined, 'the cover was not read: no sample');

  // a slow photo server: what is not read within the time limit is left unchecked ('slow'), and nothing more is asked for
  const slow = panel({ hold: true, timeUp: true });
  await slow.fns.checkBranding({ auto: true });
  assert.deepEqual(Object.values(slow.state.branding.photos).map((e) => e.reason), PHOTOS.map(() => 'slow'));
  assert.ok(slow.calls.filter((c) => c.startsWith('download')).length <= 1, 'no batch is asked for once the time is up');
  assert.equal(slow.state.brandingRun, null, 'and the form buttons come on');
  assert.match(fnText('readForBranding'), /const timeUp = sleep\(Math\.max\(0, deadline - Date\.now\(\)\)\)/);
  assert.match(fnText('checkBranding'), /deadline: Date\.now\(\) \+ BRANDING_TIME_LIMIT_MS/);
  assert.match(constText('BRANDING_TIME_LIMIT_MS'), /= 45 \* 1000;$/);
});

test('turning the setting off while the review is open lets the check go; turning it on checks a car that has none', async () => {
  const p = panel({ hold: true });
  p.fns.checkBranding({ auto: true });
  await settle();
  p.state.settings = { cropBranding: false };
  p.fns.brandingAfterSettings();
  assert.equal(p.state.brandingRun, null);
  p.held.shift()();
  await settle();
  assert.equal(p.state.branding, null, 'nothing kept from a check let go');
  assert.equal(p.store[COVER_KEY], undefined, 'and no cover sample: the setting is off');
  const on = panel();
  on.fns.brandingAfterSettings();
  await settle();
  assert.equal(on.sent.length, 6, 'on, with no check of this car yet: it checks');
});

test('a photo goes into the form cropped only with the setting on, not set back, and from the very bytes that were checked', async () => {
  const p = panel();
  p.state.branding = checked([PHOTOS[0], PHOTOS[1], PHOTOS[2]]);
  const counts = { cropped: 0, uncropped: [] };
  const files = await p.fns.forTheForm([file(PHOTOS[0]), file(PHOTOS[1], 2), file(PHOTOS[3])], counts);
  assert.deepEqual(files.map((f) => [f.name, f.type]), [['photo-01.png', 'image/png'], ['photo-02.jpg', 'image/jpeg'], ['photo-04.jpg', 'image/jpeg']], 'the name follows the new file\'s type');
  assert.equal(bytesOf(files[0].dataUrl), `cropped ${PHOTOS[0]}`);
  assert.equal(bytesOf(files[1].dataUrl), `${PHOTOS[1]}#2`, 'changed on the website since the check: the website\'s photo, as it is');
  assert.equal(bytesOf(files[2].dataUrl), `${PHOTOS[3]}#1`, 'nothing found: as it is');
  assert.deepEqual(counts, { cropped: 1, uncropped: [{ url: PHOTOS[1], why: 'changed' }] });
  assert.deepEqual(files.map((f) => Object.keys(f).sort()), files.map(() => ['dataUrl', 'name', 'type']), 'the page gets only { name, type, dataUrl }');
  assert.deepEqual(p.calls.filter((c) => c.startsWith('crop')), ['crop 1', 'crop 2'], 'only photos the check cropped are cut');

  // set back with Use original, the setting off, or another car's check: the website's photo, never cut
  for (const [what, change] of [['set back', (s) => { s.photoOriginals = [PHOTOS[0]]; }], ['the setting off', (s) => { s.settings = { cropBranding: false }; }], ['another car\'s check', (s) => { s.branding = checked([PHOTOS[0]], 'BBB'); }]]) {
    const q = panel();
    q.state.branding = checked([PHOTOS[0]]);
    change(q.state);
    const [f] = await q.fns.forTheForm([file(PHOTOS[0])], { cropped: 0, uncropped: [] });
    assert.equal(bytesOf(f.dataUrl), `${PHOTOS[0]}#1`, what);
    assert.ok(!q.calls.some((c) => c.startsWith('crop')), `${what}: not even tried`);
  }
  // a tally saved by an older version (no counts yet) still counts
  const old = panel();
  old.state.branding = checked([PHOTOS[0]]);
  const tally = {};
  await old.fns.forTheForm([file(PHOTOS[0]), file(PHOTOS[0], 3)], tally);
  assert.deepEqual(tally, { cropped: 1, uncropped: [{ url: PHOTOS[0], why: 'changed' }] });
});

// photoPickHtml and brandingHtml, as written, for a car whose check cropped photo 1
function pickView(state) {
  const fns = compileMany(['photoPickHtml', 'brandingHtml', 'brandingEntry'], {
    state, usablePhotos, isFacebookServer, settlePick, pickSummary, cropPlan, insetOf, photoNote, brandingSummary,
    esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    photoLimitNow: () => 20, pickLimit: () => 0, pickedPhotos: () => settlePick(state.photoPick, state.vehicle.photos, 0), ordinal: (n) => `${n}th`,
  }, ['brandingOn', 'brandingNow', 'setBack', 'goesCropped', 'brandingProgressText']);
  return fns.photoPickHtml();
}

test('the thumbnail of a cropped photo shows exactly the part that goes, with Use original, a note, and the choices for all', () => {
  const state = { vin: 'AAA', vehicle: { vin: 'AAA', photos: PHOTOS }, settings: { cropBranding: true }, branding: checked([PHOTOS[0], PHOTOS[1]]), photoOriginals: null, brandingRun: null, photoPick: null, fill: null };
  const html = pickView(state);
  assert.match(html, /<img src="https:\/\/img\.example\.test\/a\/1\.jpg"[^>]* style="object-view-box: inset\(0% 0% 10% 0%\)" \/>/, 'the crop of 48 of 480 rows off the bottom');
  assert.equal((html.match(/object-view-box/g) || []).length, 2, 'only the cropped photos');
  assert.match(html, /<input type="checkbox" class="photoTick" id="photo-0" data-photo="0" checked aria-describedby="photoNote-0" \/>/);
  assert.match(html, /<span class="why note" id="photoNote-0">Cropped: logo band off the bottom<\/span>/);
  assert.match(html, /<button type="button" class="copy" id="photoCrop-0" data-photo-crop="0" aria-label="Use original: photo 1" aria-describedby="photoNote-0">Use original<\/button>/);
  assert.doesNotMatch(html, /id="photoCrop-2"/, 'no choice for a photo the check did not crop');
  assert.match(html, /<h4 id="brandingLabel">Dealer branding<\/h4>/);
  assert.match(html, /id="brandingSummary">Cropped the same logo band off the bottom of 2 of 6 photos\./);
  assert.match(html, /id="photosCropAll" aria-pressed="true">Use all cropped<\/button><button type="button" class="plain" id="photosOriginalAll" aria-pressed="false">Use all originals<\/button>/);
  assert.match(html, /id="brandingCheck">Check again<\/button>/);
  assert.match(html, /Lot Current only cuts a strip off the edges of a photo; it never paints over or changes anything in the picture\. A see-through logo, a logo in the middle of the photo, or branding on the car itself stays as it is: untick that photo if it shouldn't go on the listing\./);

  // photo 1 set back: shown whole, Use cropped, the note says what stays
  state.photoOriginals = [PHOTOS[0]];
  const back = pickView(state);
  assert.doesNotMatch(back, /src="https:\/\/img\.example\.test\/a\/1\.jpg"[^>]*object-view-box/);
  assert.match(back, /id="photoCrop-0" data-photo-crop="0" aria-label="Use cropped: photo 1"[^>]*>Use cropped<\/button>/);
  assert.match(back, /id="photoNote-0">Original: logo band left on</);
  assert.match(back, /id="photosCropAll" aria-pressed="false">.*id="photosOriginalAll" aria-pressed="false">/s);
  state.photoOriginals = [PHOTOS[0], PHOTOS[1]];
  assert.match(pickView(state), /id="photosOriginalAll" aria-pressed="true">/);

  // a check under way: its progress and Skip the check, in place of Check again
  state.brandingRun = { done: 4, total: 6, stopped: false };
  const running = pickView(state);
  assert.match(running, /<p class="hint" id="brandingProgress">Checking the photos for dealer branding: 4 of 6…<\/p>/);
  assert.match(running, /id="brandingStop">Skip the check<\/button>/);
  assert.doesNotMatch(running, /id="brandingCheck"/);
  // no check yet: the button to run one
  Object.assign(state, { brandingRun: null, branding: null, photoOriginals: null });
  assert.match(pickView(state), /id="brandingCheck">Check the photos for dealer branding<\/button>/);
  assert.doesNotMatch(pickView(state), /object-view-box|photoCrop-|brandingSummary/);
  // the setting off: the website's photos, and the hint where to turn it on
  Object.assign(state, { settings: { cropBranding: false }, branding: checked([PHOTOS[0]]) });
  const off = pickView(state);
  assert.doesNotMatch(off, /object-view-box|photoCrop-|brandingCheck|photoNote-/);
  assert.match(off, /Cropping dealer branding off the photos is off for this website \(Settings\)\./);
  // another car's check is never shown on this car
  Object.assign(state, { settings: { cropBranding: true }, branding: checked([PHOTOS[0]], 'BBB') });
  assert.doesNotMatch(pickView(state), /object-view-box|photoCrop-/);
});

test('the publish step says how many photos went cropped, and which went as the website shows them', () => {
  const view = (p) => compileMany(['photosHtml'], { state: { photos: p }, blockedPatterns: () => [], esc: (x) => String(x), patternCovers: () => false, patternHost: (x) => x, allowButton: () => '' }).photosHtml();
  const base = { total: 6, limit: 20, verified: true, attached: 6, failed: [], done: true, error: null, again: false };
  const html = view({ ...base, cropped: 4, uncropped: [{ url: PHOTOS[4], why: 'changed' }, { url: PHOTOS[5], why: 'decode' }] });
  assert.match(html, /<p class="hint" id="photosCropped">4 cropped to take off dealer branding\.<\/p>/);
  assert.match(html, /id="photosChanged">One went on as the website shows it, not cropped: the photo changed on the website since the check\./);
  assert.match(html, /id="photosUncropped">One went on as the website shows it: the cropped copy couldn&#39;t be made\.|id="photosUncropped">One went on as the website shows it: the cropped copy couldn't be made\./);
  const plain = view({ ...base });
  assert.doesNotMatch(plain, /photosCropped|photosChanged|photosUncropped/, 'a run saved by an older version, or nothing cropped: no line');
});

test('a queued car\'s form waits for the photo check, and a car whose photos it cropped waits at review', async () => {
  const run = async (cropped) => {
    const calls = [];
    const state = { origin: ORIGIN, posted: {}, snapshotVehicles: { AAA: { name: '2020 Make Model' } }, settings: { salesperson: { name: 'Sam' }, basis: 'website', rulesReadAt: '2026-09-30T12:00:00.000Z', cropBranding: true }, vin: null };
    const canAutoOpen = compileMany(['canAutoOpen'], { state, currentListing: () => ({ missing: [], assumed: [], photos: PHOTOS }), dailyCap: () => ({ reached: false }), photoPatterns: () => [], refusedPhotoServers: new Set() }).canAutoOpen;
    let finish;
    const { startFlow } = compileMany(['startFlow', 'readCarNow', 'takeCar'], {
      state, chrome: { storage: { local: { remove: async () => {} } } }, GLOBAL_KEYS: { postRequest: 'postRequest' }, flowRun: 0,
      endUpkeep: () => {}, clearFlow: async () => 0, loadSaved: async () => true, refreshGranted: async () => {}, nameOf: () => '2020 Make Model',
      afterQueueStep: () => { throw new Error('afterQueueStep must not run'); }, block: () => { throw new Error('block must not run'); }, stopPosted: () => { throw new Error('stopPosted must not run'); },
      setStatus: () => {}, render: () => calls.push(`render ${state.brandingRun ? 'running' : 'idle'}`), saveFlow: async () => {},
      pilotNote: async () => {}, beginPost: () => null, notePostStep: () => null,
      readCarForPost: async ({ vin }) => ({ ok: true, vehicle: { vin, name: '2020 Make Model', price: 20000, location: '', photos: PHOTOS } }),
      recheck: () => ({ ok: true }), shortLocation: () => '', storeNames: () => [], localVinCheck: () => ({ ok: true }), basisPrice: (v) => v.price,
      maybeGuessColors: async () => {}, generate: async () => { state.guardrails = { ok: true }; }, relistNotice,
      canAutoOpen: () => { calls.push(`canAutoOpen ${state.brandingRun ? 'while running' : 'after'}`); return canAutoOpen(); },
      openForm: async () => calls.push('openForm'), postElsewhere: async () => '', elsewhereText: () => '',
      // the check: under way at once, done when the test says
      checkBranding: ({ auto }) => {
        calls.push(`checkBranding auto ${auto}`);
        state.brandingRun = { done: 0, total: 6, stopped: false };
        return new Promise((resolve) => { finish = () => { state.brandingRun = null; state.branding = checked(cropped); resolve(); }; });
      },
    });
    const started = startFlow({ origin: ORIGIN, vin: 'aaa', dealerTabId: null, queue: true });
    await settle();
    assert.ok(!calls.includes('openForm'), 'nothing opens while the check runs');
    finish();
    await started;
    return calls;
  };
  const plain = await run([]);
  assert.deepEqual(plain.filter((c) => !c.startsWith('render ') || c === 'render running'), ['checkBranding auto true', 'render running', 'canAutoOpen after', 'openForm'], 'drawn with the check under way; the car opens once it ends with nothing cropped');
  const branded = await run([PHOTOS[0]]);
  assert.deepEqual(branded.slice(-1), ['canAutoOpen after'], 'cropped photos: the car waits at review for the person');
});

test('the review, a re-read that changed the photos, a panel brought back and a Settings save each reach the photo check as described', () => {
  // startFlow: the check is marked under way before the review is drawn, and a queued car waits for it before canAutoOpen
  assert.match(fnText('startFlow'), /const photosChecked = checkBranding\(\{ auto: true \}\);[^\n]*\n\s*render\(\);/);
  assert.match(fnText('startFlow'), /if \(state\.queueMode\) await photosChecked;\n\s*if \(dropped\(\)\) return undefined;\n\s*if \(state\.queueMode && canAutoOpen\(\)\) await openForm\(\);/);
  // carStillCurrent: photos that changed are checked again
  assert.match(fnText('carStillCurrent'), /if \(changed\.some\(\(c\) => c\.key === 'photos'\)\) checkBranding\(\{ auto: true \}\);/);
  // resumeFlow: a review with no finished check of this car runs one, never one carried over from the closed panel
  assert.match(fnText('resumeFlow'), /state\.brandingRun = null;[^\n]*\n[^\n]*\n?\s*if \(state\.step === 'review'\) checkBranding\(\{ auto: true, onlyIfNone: true \}\);/);
  // openForm lets a running check go before anything else
  assert.match(fnText('openForm'), /if \(state\.opening \|\| state\.step === 'filling' \|\| state\.step === 'publish'\) return undefined;\n\s*stopBranding\(\);/);
  // reviewAfterSettings follows the setting on both of its paths
  assert.equal((fnText('reviewAfterSettings').match(/brandingAfterSettings\(\);/g) || []).length, 2);
  // the check under way is never saved, and clearFlow drops it with the rest
  const FLOW_FIELDS = new Function(`return ${/const FLOW_FIELDS = (\[[^\]]*\]);/.exec(src)[1]}`)();
  assert.ok(FLOW_FIELDS.includes('branding') && FLOW_FIELDS.includes('photoOriginals'), 'the check\'s result and the person\'s choices are saved with the post');
  assert.ok(!FLOW_FIELDS.includes('brandingRun'), 'a check under way is not');
  assert.match(fnText('clearFlow'), /branding: null, photoOriginals: null, brandingRun: null/);
  // the form buttons are off while it runs, with the hint that says when they come on
  assert.match(fnText('setFormButtons'), /const waits = Boolean\(state\.brandingRun\);/);
  assert.match(fnText('setFormButtons'), /if \(b\) b\.disabled = off \|\| waits;/);
  assert.match(src, /^const FORM_WAITS_HTML = '<p class="hint" id="formWaits">Open the Marketplace form is ready when the photo check ends, or click Skip the check\.<\/p>';$/m);
  // the pilot numbers record nothing about the photo check (legal/pilot-agreement.md section 2)
  for (const name of ['checkBranding', 'readForBranding', 'stopBranding', 'forTheForm', 'afterBrandingChoice', 'brandingAfterSettings']) assert.doesNotMatch(fnText(name), /pilotNote|notePostStep|noteFill|endPost|beginPost/, `${name} records nothing in the pilot numbers`);
});
