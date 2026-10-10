// Service worker. Its jobs:
//   1. Download a car's photos from the server they sit on (the extension has
//      permission for that server: the manifest's image host, or one Chrome
//      granted when the side panel asked from the salesperson's click; the
//      Facebook page itself has none) and hand them to the side panel as
//      data URLs. Never from Facebook's own servers, and each photo is
//      capped in size and time (downloadPhoto).
//   2. Open the side panel when the popup can't.
//   3. Rescan every known dealer website every 3 hours while Chrome is open
//      (chrome.alarms), reading it through its adapter's direct search (the
//      platform's inventory service, or the website's own pages) with the
//      host permission the wizard asked for, then update the toolbar badge
//      with the salesperson's to-do count and, optionally, notify. A website
//      that turns such a read away fails the rescan with its reason, which
//      the popup shows; the Scan button still reads it from the tab.
//   4. Sync the posted list and the pilot numbers with the dealership's
//      account server (src/accountFlow.js) after a rescan and when the popup
//      or the side panel asks (syncNow), and again a minute after the
//      server turned a sync away for coming too often (a one-shot alarm):
//      only once the owner has filled in src/accountConfig.js and the
//      person is signed in. With an empty config nothing here calls out.
// It never touches Facebook and never posts anything.

import { adapterById } from './adapters/index.js';
import { scanWithSearch, keepSeenBasis } from './src/scanRunner.js';
import { siteKeys, SITES_KEY } from './src/storageKeys.js';
import { updateKey, withLock, storageErrorText } from './src/storage.js';
import { settleDiff, withWithheld } from './src/rescan.js';
import { withDefaults } from './src/settings.js';
import { RESCAN_ALARM, RESCAN_PERIOD_MINUTES, SYNC_RETRY_MINUTES, syncRetryAlarm, originOfSyncRetryAlarm, todoCountFor, badgeText, notificationFor, isDue, latestOf, originsFor } from './src/rescanSchedule.js';
import { recordFlags } from './src/pilot.js';
import { ACCOUNT, accountsConfigured } from './src/accountConfig.js';
import { syncOnce, scanFromStored, NOT_CONFIGURED } from './src/accountFlow.js';
import { isFacebookServer } from './src/photoHosts.js';

export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
// A photo server the salesperson allowed can be slow, broken or hostile, and
// the side panel waits on each batch of photos: after this long the photo
// fails with its server named, and the others still come.
export const PHOTO_TIMEOUT_MS = 30 * 1000;

// The host a photo lives on, for the error text: a photo on a server Lot
// Current has no permission for fails here, and the error names that server
// (the site registry's photoOrigins, recorded by the scan, says where the
// lot's photos are).
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    return String(url || '').slice(0, 60);
  }
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}

class PhotoTooLarge extends Error {}

// What a downloaded file really is, from its first bytes: a JPEG, PNG, GIF,
// WebP or AVIF photo, or null. A server's content type can be missing or
// wrong (S3 serves an upload without one as binary/octet-stream), and a 200
// answer can be an error or bot-check page instead of the photo.
export function sniffPhotoType(bytes) {
  const b = bytes || new Uint8Array(0);
  const starts = (...sig) => sig.every((x, i) => b[i] === x);
  const ascii = (from, to) => String.fromCharCode(...b.subarray(from, to));
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x52, 0x49, 0x46, 0x46) && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 12 && ascii(4, 8) === 'ftyp' && /^avi[fs]$/.test(ascii(8, 12))) return 'image/avif';
  return null;
}

// The content types of the formats sniffPhotoType knows: a body under one of
// these that shows none of them is not that photo.
const KNOWN_PHOTO_TYPE = /^image\/(?:jpe?g|pjpeg|png|gif|webp|avif)$/;

// The type a downloaded file goes to the form with, or null when it is not a
// photo. An empty body is never a photo. The bytes win when they show a
// photo format, whatever the header says. Otherwise only a server that calls
// it an image of a format the bytes check doesn't know (any image/ type, such as
// HEIC or SVG) is believed: an SVG only when the body is an SVG drawing, any
// other only when the body is not a page of markup. Anything else (a
// text/html answer, a missing or octet-stream type over bytes of no photo
// format, an empty, JSON or text body under a JPEG or PNG type) is no photo.
export function photoTypeFor(declared, bytes) {
  const b = bytes || new Uint8Array(0);
  if (!b.length) return null;
  const sniffed = sniffPhotoType(b);
  if (sniffed) return sniffed;
  const type = String(declared || '').toLowerCase();
  if (!/^image\/[\w.+-]+$/.test(type) || KNOWN_PHOTO_TYPE.test(type)) return null;
  const head = String.fromCharCode(...b.subarray(0, 1024)).toLowerCase();
  if (type === 'image/svg+xml') return /<svg[\s>]/.test(head) && !/<html[\s>]|<!doctype html/.test(head) ? type : null;
  if (/^[\s\u00ef\u00bb\u00bf]*</.test(head)) return null; // '<': an HTML page under an image type
  return type;
}

// The file name's ending for a photo type: the usual one for the formats
// above, else the type's own name (image/heic: heic).
function photoExtension(type) {
  const known = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg' };
  return known[type] || type.slice('image/'.length).replace(/^x-/, '').replace(/[^a-z0-9]/g, '').slice(0, 8) || 'img';
}

// The body, read a chunk at a time and given up on as soon as it passes the
// cap: a server that sends gigabytes never gets them into memory. Every read
// races the timeout, so a body that stops arriving ends the download too.
async function cappedBytes(res, deadline) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buffer = await Promise.race([res.arrayBuffer(), deadline]);
    if (buffer.byteLength > MAX_PHOTO_BYTES) throw new PhotoTooLarge();
    return new Uint8Array(buffer);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PHOTO_BYTES) throw new PhotoTooLarge();
      chunks.push(value);
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    throw e;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return bytes;
}

// fetchImpl and timeoutMs are for the tests; the worker uses fetch and the 30 seconds.
export async function downloadPhoto(url, index, { fetchImpl = globalThis.fetch, timeoutMs = PHOTO_TIMEOUT_MS } = {}) {
  if (isFacebookServer(url)) return { url, ok: false, error: `on Facebook's servers (${hostOf(url)}); Lot Current doesn't download from Facebook` };
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no complete answer in ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
  });
  deadline.catch(() => {}); // raced below; a photo that finished first leaves nothing waiting on it
  try {
    const res = await Promise.race([fetchImpl(url, { credentials: 'omit', signal: controller.signal }), deadline]);
    // An address that redirected to one of Facebook's servers: its answer is
    // dropped unread, as one asked for there directly is never requested.
    // Redirects are still followed, since a dealer's image server may move a
    // photo to its own CDN; res.url is where the answer came from.
    if (isFacebookServer(res.url)) {
      if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
      return { url, ok: false, error: `redirected to Facebook's servers (${hostOf(res.url)}); Lot Current doesn't download from Facebook` };
    }
    if (!res.ok) return { url, ok: false, error: `HTTP ${res.status} from ${hostOf(url)}` };
    const declared = (res.headers.get('content-type') || '').split(';')[0].trim();
    // A server that says up front the photo is too large is not read at all.
    if (Number(res.headers.get('content-length')) > MAX_PHOTO_BYTES) {
      if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
      throw new PhotoTooLarge();
    }
    const bytes = await cappedBytes(res, deadline);
    // a 200 answer that is not a photo (an error or bot-check page) is a
    // photo that couldn't be downloaded, never one attached under a .jpg name
    const type = photoTypeFor(declared, bytes);
    if (!type) return { url, ok: false, error: `not a photo (${declared || 'no type given'}) from ${hostOf(url)}` };
    const ext = photoExtension(type);
    return {
      url,
      ok: true,
      name: `photo-${String(index + 1).padStart(2, '0')}.${ext}`,
      type,
      bytes: bytes.byteLength,
      dataUrl: `data:${type};base64,${toBase64(bytes)}`,
    };
  } catch (e) {
    if (e instanceof PhotoTooLarge) return { url, ok: false, error: `too large (${hostOf(url)})` };
    return { url, ok: false, error: `${hostOf(url)}: ${String((e && e.message) || e)}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- automatic rescans ----------
// The keys are named in src/storageKeys.js. The site registry is shared with
// the popup (auto on or off, clearing a website) and the scan runner, so
// every change to it is a read-modify-write under its lock (src/storage.js).

async function loadSites() {
  const data = await chrome.storage.local.get(SITES_KEY);
  return data[SITES_KEY] || {};
}

const updateSites = (change) => updateKey(SITES_KEY, (sites) => change(sites || {}));

// ---------- accounts: sync ----------
// One round of sync for one website (src/accountFlow.js syncOnce): the
// registry and the pilot changes go up, the dealership's registry comes down
// and is merged under the keys' locks. It runs here, in one place, whether
// a rescan, the popup (a scan, a post marked, taken down or updated, Sync
// now), the panel (a confirmed post, a take-down or price update it saw
// done) or set-up asked for it; one sync per website at a time. A request
// made while one runs may carry a change that sync read too early (a
// take-down clicked a second after a post), so one more sync follows it,
// shared by every request made meanwhile, and they all get its result. A
// sync the account server turns away for coming too often (a 429: its
// per-person brake is a dozen a minute, which a salesperson marking a lot of
// cars passes) is tried again a minute later (planRetry). The outcome is
// recorded on the website's registry entry (lastSyncAttempt, lastSync,
// lastSyncError, lastSyncRetry) so Settings can show it. Never throws: a
// failed sync is a result, not an exception.
const syncing = new Map(); // origin -> { run, again, scan }: the sync under way, the one to follow it, and the scan it sends

export function syncSite(origin, { scan = null } = {}) {
  if (!accountsConfigured()) return Promise.resolve({ ok: false, notConfigured: true, error: NOT_CONFIGURED });
  const key = String(origin || '');
  const current = syncing.get(key);
  if (!current) return startSync(key, scan);
  if (scan) current.scan = scan; // the newest scan asked for; none means the stored one
  if (!current.again) {
    current.again = current.run.then(() => {
      if (syncing.get(key) === current) syncing.delete(key);
      return syncSite(key, { scan: current.scan });
    });
  }
  return current.again;
}

function startSync(key, scan) {
  const entry = { run: null, again: null, scan: null };
  entry.run = (async () => {
    let r;
    try {
      r = await syncOnce({ origin: key, scan, deps: { config: ACCOUNT, fetchImpl: fetch, storage: chrome.storage.local } });
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) };
    }
    const retryAt = await planRetry(key, r);
    const at = new Date().toISOString();
    try {
      await updateSites((sites) => (sites[key]
        ? { ...sites, [key]: { ...sites[key], lastSyncAttempt: at, ...(r.ok ? { lastSync: at, lastSyncError: null, lastSyncRetry: null } : { lastSyncError: r.error || 'unknown error', ...(retryAt ? { lastSyncRetry: retryAt } : {}) }) } }
        : undefined)); // a website not registered for rescans has nowhere to record it; the result still says
    } catch (e) { /* the registry could not be written; the result still says what happened */ }
    return retryAt ? { ...r, retryAt } : r;
  })();
  syncing.set(key, entry);
  entry.run.finally(() => { if (syncing.get(key) === entry) syncing.delete(key); });
  return entry.run;
}

// After a 429 from the account server, one more sync a minute later, when
// its minute has passed: it sends the whole registry as it is then, so every
// change the refused syncs carried goes up. An alarm, not a timer, because
// Chrome stops an idle worker well before a minute. One per website: a later
// refusal moves it, and a sync that gets through first cancels it, having
// sent everything. Any other failure (offline, signed out, a lapsed plan)
// sets none; the next scan, post or Sync now tries again as before. Returns
// when the retry is due, or null.
async function planRetry(key, r) {
  if (!chrome.alarms || typeof chrome.alarms.create !== 'function') return null;
  const name = syncRetryAlarm(key);
  try {
    if (r.ok) {
      await chrome.alarms.clear(name);
      return null;
    }
    if (r.status !== 429) return null;
    const due = new Date(Date.now() + SYNC_RETRY_MINUTES * 60 * 1000).toISOString();
    await chrome.alarms.create(name, { delayInMinutes: SYNC_RETRY_MINUTES });
    return due;
  } catch (e) {
    return null; // no alarm: the next scan, post or Sync now still syncs
  }
}

export async function updateBadge() {
  const sites = await loadSites();
  const origins = Object.keys(sites);
  const data = await chrome.storage.local.get(origins.map((o) => siteKeys(o).diff));
  let count = 0;
  for (const o of origins) count += todoCountFor(data[siteKeys(o).diff]);
  await chrome.action.setBadgeBackgroundColor({ color: '#9f1d1d' });
  await chrome.action.setBadgeText({ text: badgeText(count) });
  return count;
}

// The service is the adapter's own data: only the adapter says which hosts it needs.
async function hasPermission(info, adapter) {
  const origins = originsFor(info.site || { origin: info.origin }, adapter.origins(info.service));
  if (!origins.length) return false;
  try {
    return await chrome.permissions.contains({ origins });
  } catch (e) {
    return false;
  }
}

export const NO_PERMISSION = 'Lot Current has no permission to read this website in the background. Click Allow automatic rescans in Settings.';
export const NO_SETTINGS = 'This website has no settings on this computer (they were cleared, or set-up never finished). Scan it from the popup first.';

// A failed attempt is recorded so the popup can show that the schedule is not
// working, with what asked for it (the alarm, or the side panel's Rescan).
async function noteFailure(origin, info, error, reason = 'alarm') {
  try {
    await updateSites((sites) => ({ ...sites, [origin]: { ...(sites[origin] || info), lastAttempt: new Date().toISOString(), lastError: error, lastReason: reason } }));
  } catch (e) { /* the registry could not be written either; the result still says what failed */ }
  return { ok: false, error };
}

// One rescan of one website, from the service worker: same code path as the
// popup's Scan button, with the service called directly. It only reads: the
// settings are never written back from here.
export async function runRescan(origin, { reason = 'alarm' } = {}) {
  const sites = await loadSites();
  const info = sites[origin];
  if (!info || !info.service) return { ok: false, error: 'This website has not been scanned from the popup yet.' };
  const adapter = adapterById(info.adapter);
  if (!adapter) return noteFailure(origin, info, `No adapter for ${info.adapter}`, reason);
  if (!(await hasPermission({ ...info, origin }, adapter))) return noteFailure(origin, info, NO_PERMISSION, reason);
  const k = siteKeys(origin);
  const data = await chrome.storage.local.get([k.settings, k.snapshot, k.posted, k.boilerplate]);
  if (!data[k.settings]) return noteFailure(origin, info, NO_SETTINGS, reason);
  const site = { ...(info.site || {}), origin, name: info.name, adapter: info.adapter };
  const settings = withDefaults(data[k.settings], site);
  const now = new Date().toISOString();
  let out;
  try {
    out = await scanWithSearch({ adapter, search: adapter.makeDirectSearch(info.service), site, settings, prevSnapshot: data[k.snapshot] || null, posted: data[k.posted] || {}, options: adapter.scanOptions(info.service), boilerplate: data[k.boilerplate] || [] });
  } catch (e) {
    out = { ok: false, message: String((e && e.message) || e) };
  }
  if (!out.ok) return noteFailure(origin, info, out.message, reason);
  // Saved under the diff's lock, against the posted list as it is now: the
  // salesperson may have ticked an item off while this scan ran, and the
  // popup and the side panel change the diff under the same lock
  // (src/rescan.js settleDiff, src/storage.js). A read judged a website
  // hiccup is not saved as the snapshot: it is held back with the diff,
  // counted on from the one saved before (withWithheld), for the popup to
  // offer; only the salesperson's click there replaces the snapshot.
  let diff;
  let before;
  try {
    ({ diff, before } = await withLock(k.diff, async () => {
      const now = await chrome.storage.local.get([k.posted, k.diff]);
      const settled = withWithheld(settleDiff(out.diff, now[k.posted] || {}), out.snapshot, now[k.diff]);
      const save = { [k.diff]: settled, [k.boilerplate]: out.boilerplate };
      if (!settled.unreliable) save[k.snapshot] = out.snapshot;
      await chrome.storage.local.set(save);
      return { diff: settled, before: now[k.diff] };
    }));
  } catch (e) {
    return noteFailure(origin, info, storageErrorText(e), reason); // the quota, most likely: the popup's To do shows it as the last error
  }
  await recordFlags(origin, diff, out.res.fetchedAt).catch(() => null); // pilot numbers: when a to-do item first appeared
  await keepSeenBasis(origin, data[k.snapshot] || null, out.snapshot, diff).catch(() => null); // the price basis this read shows for a listing that has none; none from a held-back read
  const count = todoCountFor(diff);
  // Compared with the person's outstanding list (the saved diff, which the
  // popup and upkeep trim as items are handled), not with the last rescan's count.
  const note = notificationFor(todoCountFor(before), count);
  try {
    await updateSites((sites) => ({ ...sites, [origin]: { ...(sites[origin] || info), photoOrigins: out.photoOrigins, lastScan: out.res.fetchedAt, lastAttempt: now, lastError: null, lastReason: reason, lastNotifiedCount: count } }));
  } catch (e) {
    return noteFailure(origin, info, storageErrorText(e), reason);
  }
  await updateBadge();
  // the dealership's shared registry, once accounts exist: recorded on the site entry, never a reason for the rescan to fail
  if (accountsConfigured()) await syncSite(origin, { scan: scanFromStored({ snapshot: out.snapshot, diff }) });
  if (note && settings.notify !== false && reason === 'alarm') {
    try {
      await chrome.notifications.create(`lot-sync-${origin}`, { type: 'basic', iconUrl: 'icons/icon128.png', title: note.title, message: `${note.message} (${info.name || origin})`, priority: 0 });
    } catch (e) { /* notifications may be blocked; the badge still shows */ }
  }
  return { ok: true, count, warnings: diff.warnings, cars: Object.keys(out.snapshot.vehicles).length };
}

async function rescanDueSites(reason) {
  const sites = await loadSites();
  const results = {};
  for (const [origin, info] of Object.entries(sites)) {
    if (!info.auto) continue;
    if (reason === 'alarm' && !isDue(latestOf(info.lastAttempt, info.lastScan))) continue;
    try {
      results[origin] = await runRescan(origin, { reason });
    } catch (e) {
      results[origin] = { ok: false, error: String((e && e.message) || e) }; // one website's failure never stops the others
    }
  }
  return results;
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(RESCAN_ALARM);
  if (!existing) await chrome.alarms.create(RESCAN_ALARM, { periodInMinutes: RESCAN_PERIOD_MINUTES, delayInMinutes: RESCAN_PERIOD_MINUTES });
}

// The 3-hourly rescan, and a sync retried after the account server asked
// to wait (planRetry). The promise is for the tests; Chrome ignores it.
function onAlarm(alarm) {
  if (!alarm) return undefined;
  if (alarm.name === RESCAN_ALARM) return rescanDueSites('alarm');
  const origin = originOfSyncRetryAlarm(alarm.name);
  if (origin) return syncSite(origin);
  return undefined;
}

chrome.alarms.onAlarm.addListener(onAlarm);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type === 'downloadPhotos') {
    const urls = Array.isArray(msg.urls) ? msg.urls.slice(0, 10) : [];
    Promise.all(urls.map((u, i) => downloadPhoto(u, (msg.offset || 0) + i))).then((photos) => sendResponse({ ok: true, photos }));
    return true;
  }
  if (msg.type === 'openSidePanel') {
    const target = msg.windowId ? { windowId: msg.windowId } : { tabId: msg.tabId };
    chrome.sidePanel.open(target).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'updateBadge') {
    updateBadge().then((count) => sendResponse({ ok: true, count })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'rescanNow') {
    runRescan(msg.origin, { reason: msg.reason || 'manual' }).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'syncNow') {
    syncSite(msg.origin).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'ensureAlarm') {
    ensureAlarm().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  // The toolbar icon keeps opening the popup; the side panel is opened from "Post".
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  }
  ensureAlarm().catch(() => {});
  updateBadge().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm().catch(() => {});
  updateBadge().catch(() => {});
});
