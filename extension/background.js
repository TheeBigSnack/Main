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
import { scanWithSearch, SITES_KEY } from './src/scanRunner.js';
import { withDefaults } from './src/settings.js';
import { RESCAN_ALARM, RESCAN_PERIOD_MINUTES, todoCountFor, badgeText, notificationFor, isDue, originsFor } from './src/rescanSchedule.js';

const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

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
    if (!res.ok) return { url, ok: false, error: 'HTTP ' + res.status };
    const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_PHOTO_BYTES) return { url, ok: false, error: 'too large' };
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
    return { url, ok: false, error: String((e && e.message) || e) };
  }
}

// ---------- automatic rescans ----------

const keysFor = (origin) => ({ settings: `settings:${origin}`, snapshot: `snapshot:${origin}`, diff: `diff:${origin}`, posted: `posted:${origin}`, boilerplate: `boilerplate:${origin}` });

async function loadSites() {
  const data = await chrome.storage.local.get(SITES_KEY);
  return data[SITES_KEY] || {};
}

export async function updateBadge() {
  const sites = await loadSites();
  const origins = Object.keys(sites);
  const data = await chrome.storage.local.get(origins.map((o) => keysFor(o).diff));
  let count = 0;
  for (const o of origins) count += todoCountFor(data[keysFor(o).diff]);
  await chrome.action.setBadgeBackgroundColor({ color: '#9f1d1d' });
  await chrome.action.setBadgeText({ text: badgeText(count) });
  return count;
}

async function hasPermission(info) {
  const origins = originsFor(info.site || { origin: info.origin }, info.service);
  if (!origins.length) return false;
  try {
    return await chrome.permissions.contains({ origins });
  } catch (e) {
    return false;
  }
}

// One rescan of one website, from the service worker: same code path as the
// popup's Scan button, with the service called directly.
export async function runRescan(origin, { reason = 'alarm' } = {}) {
  const sites = await loadSites();
  const info = sites[origin];
  if (!info || !info.service) return { ok: false, error: 'This website has not been scanned from the popup yet.' };
  const adapter = adapterById(info.adapter);
  if (!adapter) return { ok: false, error: `No adapter for ${info.adapter}` };
  if (!(await hasPermission({ ...info, origin }))) return { ok: false, error: 'Lot Sync has no permission to read this website in the background. Grant it in the set-up wizard.' };
  const k = keysFor(origin);
  const data = await chrome.storage.local.get([k.settings, k.snapshot, k.posted]);
  const site = { ...(info.site || {}), origin, name: info.name, adapter: info.adapter };
  const settings = withDefaults(data[k.settings] || {}, site);
  const now = new Date().toISOString();
  let out;
  try {
    out = await scanWithSearch({ adapter, search: adapter.makeDirectSearch(info.service), site, settings, prevSnapshot: data[k.snapshot] || null, posted: data[k.posted] || {}, status: info.service.visibleStatusValues || null });
  } catch (e) {
    out = { ok: false, message: String((e && e.message) || e) };
  }
  const fresh = await loadSites();
  if (!out.ok) {
    fresh[origin] = { ...(fresh[origin] || info), lastAttempt: now, lastError: out.message };
    await chrome.storage.local.set({ [SITES_KEY]: fresh });
    return { ok: false, error: out.message };
  }
  const save = { [k.diff]: out.diff, [k.boilerplate]: out.boilerplate, [k.settings]: settings };
  if (!out.diff.unreliable) save[k.snapshot] = out.snapshot;
  await chrome.storage.local.set(save);
  const count = todoCountFor(out.diff);
  const note = notificationFor(fresh[origin] && fresh[origin].lastNotifiedCount, count);
  fresh[origin] = { ...(fresh[origin] || info), lastScan: out.res.fetchedAt, lastAttempt: now, lastError: null, lastReason: reason, lastNotifiedCount: count };
  await chrome.storage.local.set({ [SITES_KEY]: fresh });
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
    if (reason === 'alarm' && !isDue(info.lastScan)) continue;
    results[origin] = await runRescan(origin, { reason });
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
