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
//      or the side panel asks (syncNow): only once the owner has filled in
//      src/accountConfig.js and the person is signed in. With an empty
//      config nothing here calls out.
// It never touches Facebook and never posts anything.

import { adapterById } from './adapters/index.js';
import { scanWithSearch } from './src/scanRunner.js';
import { siteKeys, SITES_KEY } from './src/storageKeys.js';
import { updateKey, storageErrorText } from './src/storage.js';
import { withDefaults } from './src/settings.js';
import { RESCAN_ALARM, RESCAN_PERIOD_MINUTES, todoCountFor, badgeText, notificationFor, isDue, latestOf, originsFor } from './src/rescanSchedule.js';
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
    if (!res.ok) return { url, ok: false, error: `HTTP ${res.status} from ${hostOf(url)}` };
    const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    // A server that says up front the photo is too large is not read at all.
    if (Number(res.headers.get('content-length')) > MAX_PHOTO_BYTES) {
      if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
      throw new PhotoTooLarge();
    }
    const bytes = await cappedBytes(res, deadline);
    const ext = /png/i.test(type) ? 'png' : /webp/i.test(type) ? 'webp' : 'jpg';
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
// a rescan, the popup's Sync now or the panel's confirmed post asked for
// it; one sync per website at a time, a second request while one runs gets
// the same result. The outcome is recorded on the website's registry entry
// (lastSyncAttempt, lastSync, lastSyncError) so Settings can show it. Never
// throws: a failed sync is a result, not an exception.
const syncing = new Map(); // origin -> the promise of the sync under way

export function syncSite(origin, { scan = null } = {}) {
  if (!accountsConfigured()) return Promise.resolve({ ok: false, notConfigured: true, error: NOT_CONFIGURED });
  const key = String(origin || '');
  if (syncing.has(key)) return syncing.get(key);
  const run = (async () => {
    let r;
    try {
      r = await syncOnce({ origin: key, scan, deps: { config: ACCOUNT, fetchImpl: fetch, storage: chrome.storage.local } });
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) };
    }
    const at = new Date().toISOString();
    try {
      await updateSites((sites) => (sites[key]
        ? { ...sites, [key]: { ...sites[key], lastSyncAttempt: at, ...(r.ok ? { lastSync: at, lastSyncError: null } : { lastSyncError: r.error || 'unknown error' }) } }
        : undefined)); // a website not registered for rescans has nowhere to record it; the result still says
    } catch (e) { /* the registry could not be written; the result still says what happened */ }
    return r;
  })();
  syncing.set(key, run);
  run.finally(() => { if (syncing.get(key) === run) syncing.delete(key); });
  return run;
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

// A failed attempt is recorded so the popup can show that the schedule is not working.
async function noteFailure(origin, info, error) {
  try {
    await updateSites((sites) => ({ ...sites, [origin]: { ...(sites[origin] || info), lastAttempt: new Date().toISOString(), lastError: error } }));
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
  if (!adapter) return noteFailure(origin, info, `No adapter for ${info.adapter}`);
  if (!(await hasPermission({ ...info, origin }, adapter))) return noteFailure(origin, info, NO_PERMISSION);
  const k = siteKeys(origin);
  const data = await chrome.storage.local.get([k.settings, k.snapshot, k.posted, k.diff, k.boilerplate]);
  if (!data[k.settings]) return noteFailure(origin, info, NO_SETTINGS);
  const site = { ...(info.site || {}), origin, name: info.name, adapter: info.adapter };
  const settings = withDefaults(data[k.settings], site);
  const now = new Date().toISOString();
  let out;
  try {
    out = await scanWithSearch({ adapter, search: adapter.makeDirectSearch(info.service), site, settings, prevSnapshot: data[k.snapshot] || null, posted: data[k.posted] || {}, options: adapter.scanOptions(info.service), boilerplate: data[k.boilerplate] || [] });
  } catch (e) {
    out = { ok: false, message: String((e && e.message) || e) };
  }
  if (!out.ok) return noteFailure(origin, info, out.message);
  const save = { [k.diff]: out.diff, [k.boilerplate]: out.boilerplate };
  if (!out.diff.unreliable) save[k.snapshot] = out.snapshot;
  try {
    await chrome.storage.local.set(save);
  } catch (e) {
    return noteFailure(origin, info, storageErrorText(e)); // the quota, most likely: the popup's To do shows it as the last error
  }
  await recordFlags(origin, out.diff, out.res.fetchedAt).catch(() => null); // pilot numbers: when a to-do item first appeared
  const count = todoCountFor(out.diff);
  // Compared with the person's outstanding list (the saved diff, which the
  // popup and upkeep trim as items are handled), not with the last rescan's count.
  const note = notificationFor(todoCountFor(data[k.diff]), count);
  try {
    await updateSites((sites) => ({ ...sites, [origin]: { ...(sites[origin] || info), photoOrigins: out.photoOrigins, lastScan: out.res.fetchedAt, lastAttempt: now, lastError: null, lastReason: reason, lastNotifiedCount: count } }));
  } catch (e) {
    return noteFailure(origin, info, storageErrorText(e));
  }
  await updateBadge();
  // the dealership's shared registry, once accounts exist: recorded on the site entry, never a reason for the rescan to fail
  if (accountsConfigured()) await syncSite(origin, { scan: scanFromStored({ snapshot: out.snapshot, diff: out.diff }) });
  if (note && settings.notify !== false && reason === 'alarm') {
    try {
      await chrome.notifications.create(`lot-sync-${origin}`, { type: 'basic', iconUrl: 'icons/icon128.png', title: note.title, message: `${note.message} (${info.name || origin})`, priority: 0 });
    } catch (e) { /* notifications may be blocked; the badge still shows */ }
  }
  return { ok: true, count, warnings: out.diff.warnings, cars: Object.keys(out.snapshot.vehicles).length };
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RESCAN_ALARM) rescanDueSites('alarm');
});

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
