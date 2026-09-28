// Service worker. Its jobs:
//   1. Download a car's photos from the dealer's image host (the extension has
//      permission for that host; the Facebook page itself does not) and hand
//      them to the side panel as data URLs.
//   2. Open the side panel when the popup can't.
//   3. Rescan every known dealer website every 3 hours while Chrome is open
//      (chrome.alarms), calling the site's inventory service directly with
//      the host permission the wizard asked for, then update the toolbar badge
//      with the salesperson's to-do count and, optionally, notify.
// It never touches Facebook and never posts anything.

import { adapterById } from './adapters/index.js';
import { scanWithSearch } from './src/scanRunner.js';
import { siteKeys, SITES_KEY } from './src/storageKeys.js';
import { updateKey, storageErrorText } from './src/storage.js';
import { withDefaults } from './src/settings.js';
import { RESCAN_ALARM, RESCAN_PERIOD_MINUTES, todoCountFor, badgeText, notificationFor, isDue, latestOf, originsFor } from './src/rescanSchedule.js';
import { recordFlags } from './src/pilot.js';

const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

// The host a photo lives on, for the error text: the manifest names one
// image host; a lot whose photos sit elsewhere fails here, and the site
// registry's photoOrigins (recorded by the scan) says where they are.
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

async function downloadPhoto(url, index) {
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return { url, ok: false, error: `HTTP ${res.status} from ${hostOf(url)}` };
    const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_PHOTO_BYTES) return { url, ok: false, error: `too large (${hostOf(url)})` };
    const ext = /png/i.test(type) ? 'png' : /webp/i.test(type) ? 'webp' : 'jpg';
    return {
      url,
      ok: true,
      name: `photo-${String(index + 1).padStart(2, '0')}.${ext}`,
      type,
      bytes: buffer.byteLength,
      dataUrl: `data:${type};base64,${toBase64(buffer)}`,
    };
  } catch (e) {
    return { url, ok: false, error: `${hostOf(url)}: ${String((e && e.message) || e)}` };
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

export const NO_PERMISSION = 'Lot Sync has no permission to read this website in the background. Click Allow automatic rescans in Settings.';
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
  const data = await chrome.storage.local.get([k.settings, k.snapshot, k.posted, k.diff]);
  if (!data[k.settings]) return noteFailure(origin, info, NO_SETTINGS);
  const site = { ...(info.site || {}), origin, name: info.name, adapter: info.adapter };
  const settings = withDefaults(data[k.settings], site);
  const now = new Date().toISOString();
  let out;
  try {
    out = await scanWithSearch({ adapter, search: adapter.makeDirectSearch(info.service), site, settings, prevSnapshot: data[k.snapshot] || null, posted: data[k.posted] || {}, options: adapter.scanOptions(info.service) });
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
