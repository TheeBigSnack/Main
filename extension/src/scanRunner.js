// Everything a scan needs after the records come back, shared by the popup's
// Scan button and the background rescan: normalise, assess, snapshot, diff,
// boilerplate. Plus the two ways to reach the inventory service from a tab.

import { detectAdapter } from '../adapters/index.js';
import { assessVehicle } from './classify.js';
import { makeSnapshot, diffScans } from './rescan.js';
import { findBoilerplate } from './description.js';
import { withDefaults, defaultSettings } from './settings.js';
import { probeSiteInPage, searchInPage } from './scan.js';

export async function probeTab(tabId) {
  const [inj] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: probeSiteInPage });
  return (inj && inj.result) || null;
}

// A search(body) that asks the dealer's own tab to make the request (no host
// permission needed; the page's helper does the work).
export function searchViaTab(tabId, service) {
  return async (body) => {
    const [inj] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: searchInPage, args: [service, body] });
    const r = inj && inj.result;
    if (!r || !r.ok) throw new Error((r && r.error) || 'no answer from the page');
    return r.data;
  };
}

export { detectAdapter };

// The site as kept in a snapshot: no service details (those live in `sites`).
export function siteForSnapshot(site) {
  return { origin: site.origin, host: site.host, name: site.name, title: site.title, address: site.address || null, adapter: site.adapter || null };
}

/**
 * @param {object} args
 *   adapter, search, site (from the probe, plus adapter id), settings,
 *   prevSnapshot, posted, status (the service's visible statuses, optional)
 */
export async function scanWithSearch({ adapter, search, site, settings, prevSnapshot = null, posted = {}, status = null }) {
  const confirmVins = [...new Set([...Object.keys((prevSnapshot && prevSnapshot.vehicles) || {}), ...Object.keys(posted || {})])];
  const res = await adapter.scan(search, { confirmVins, ...(status ? { status } : {}) });
  if (!res.ok) return { ok: false, message: res.message, res };
  const vehicles = res.records.map(adapter.normalize).filter(Boolean);
  const assessments = vehicles.map((v) => assessVehicle(v, settings));
  const snapshot = makeSnapshot({ site: siteForSnapshot(site), takenAt: res.fetchedAt, complete: res.complete, vehicles, assessments });
  const diff = diffScans(prevSnapshot, snapshot, { posted, confirm: res.confirm, basis: settings.basis });
  if (!res.complete) diff.warnings.unshift(`The website returned ${res.records.length} of ${res.total} cars. Missing cars were double-checked one by one.`);
  diff.takenAt = res.fetchedAt;
  diff.requests = res.requests;
  // Text that repeats across the lot (disclaimers, legal lines) is kept so the description writer can strip it.
  const boilerplate = [...findBoilerplate(vehicles.map((v) => v.descriptionRaw))];
  return { ok: true, res, vehicles, assessments, snapshot, diff, boilerplate };
}

export const UNSUPPORTED_MESSAGE = "This page doesn't have the inventory search this tool reads (Dealer Inspire's search service). Open your dealership's website and try again.";

/**
 * A full scan from a dealer tab: probe, detect the adapter, read the lot,
 * settle the settings (first scan: defaults from the site; from the synced
 * profile: keep only store names this website has), assess, diff, remember
 * the site for background rescans. Used by the popup's Scan button and the
 * set-up wizard.
 */
export async function performScan({ tabId, origin, settings = null, settingsFromProfile = false, snapshot = null, posted = {} }) {
  const probe = await probeTab(tabId);
  const adapter = probe && detectAdapter(probe);
  if (!adapter) return { ok: false, message: UNSUPPORTED_MESSAGE };
  const site = { ...probe.site, adapter: adapter.PLATFORM.id };
  const search = searchViaTab(tabId, probe.service);
  let s = settings ? withDefaults(settings, site) : null;
  const out = await scanWithSearch({ adapter, search, site, settings: s || withDefaults({}, site), prevSnapshot: snapshot, posted, status: probe.service.visibleStatusValues });
  if (!out.ok) return { ok: false, message: out.message || "Couldn't read this page." };
  let result = out;
  if (!s || settingsFromProfile) {
    if (s && settingsFromProfile) {
      const here = new Set(out.vehicles.map((v) => v.location).filter(Boolean));
      const kept = s.myStores.filter((st) => here.has(st));
      s = withDefaults({ ...s, myStores: kept.length ? kept : defaultSettings(site, out.vehicles).myStores }, site);
    } else {
      s = defaultSettings(site, out.vehicles);
    }
    // the store choice changes what is "ready": assess again with the real settings (no second request)
    const assessments = out.vehicles.map((v) => assessVehicle(v, s));
    const snap = makeSnapshot({ site: out.snapshot.site, takenAt: out.res.fetchedAt, complete: out.res.complete, vehicles: out.vehicles, assessments });
    const diff = diffScans(snapshot, snap, { posted, confirm: out.res.confirm, basis: s.basis });
    diff.takenAt = out.res.fetchedAt;
    diff.requests = out.res.requests;
    if (!out.res.complete) diff.warnings.unshift(out.diff.warnings[0]);
    result = { ...out, snapshot: snap, diff };
  }
  await rememberSite(origin, { name: site.name, adapter: adapter.PLATFORM.id, service: probe.service, site: out.snapshot.site, lastScan: result.res.fetchedAt, lastError: null, auto: Boolean(s.autoRescan) });
  return { ok: true, settings: s, site, service: probe.service, adapterId: adapter.PLATFORM.id, snapshot: result.snapshot, diff: result.diff, boilerplate: result.boilerplate, vehicles: result.vehicles, res: result.res };
}

// Sites the extension knows, for background rescans:
// { [origin]: { name, adapter, service, site, auto, lastScan, lastError, lastNotifiedCount } }
export const SITES_KEY = 'sites';

export async function rememberSite(origin, info) {
  const data = await chrome.storage.local.get(SITES_KEY);
  const sites = data[SITES_KEY] || {};
  sites[origin] = { ...(sites[origin] || {}), ...info };
  await chrome.storage.local.set({ [SITES_KEY]: sites });
  return sites[origin];
}
