// Everything a scan needs after the records come back, shared by the popup's
// Scan button, the wizard and the background rescan: normalise, assess,
// snapshot, diff, boilerplate. Plus the two ways to reach the inventory
// service from a tab, both through code the adapters own.

import { ADAPTERS, detectAdapter, unsupportedSiteMessage } from '../adapters/index.js';
import { assessVehicle } from './classify.js';
import { makeSnapshot, diffScans } from './rescan.js';
import { findBoilerplate } from './description.js';
import { withDefaults, defaultSettings } from './settings.js';
import { probeSiteInPage } from './scan.js';
import { SITES_KEY } from './storageKeys.js';
import { updateKey } from './storage.js';

/**
 * What the dealer tab says about itself and which platform it runs on: the
 * neutral probe (src/scan.js) for the site, then each adapter's own in-page
 * probe, in ADAPTERS order, until one returns its service.
 * @returns {{ site, service, adapterId } | null}  service and adapterId are
 *   null on a page no adapter recognises; null when the tab gave no answer.
 */
export async function probeTab(tabId) {
  const [inj] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: probeSiteInPage });
  const site = (inj && inj.result) || null;
  if (!site) return null;
  for (const adapter of ADAPTERS) {
    const [got] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: adapter.probeInPage });
    const service = (got && got.result) || null;
    if (service) return { site, service, adapterId: adapter.PLATFORM.id };
  }
  return { site, service: null, adapterId: null };
}

// A search(body) that asks the dealer's own tab to make the request through
// the adapter's in-page search (no host permission needed; the page's own
// code does the work).
export function searchViaTab(tabId, adapter, service) {
  return async (body) => {
    const [inj] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: adapter.searchInPage, args: [service, body] });
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
 *   prevSnapshot, posted, options (adapter.scanOptions(service), optional)
 */
export async function scanWithSearch({ adapter, search, site, settings, prevSnapshot = null, posted = {}, options = null }) {
  const confirmVins = [...new Set([...Object.keys((prevSnapshot && prevSnapshot.vehicles) || {}), ...Object.keys(posted || {})])];
  const res = await adapter.scan(search, { ...(options || {}), confirmVins });
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
  // Where this lot's photos are hosted: recorded, never requested (a permission change is the owner's call).
  const photoOrigins = typeof adapter.photoOrigins === 'function' ? adapter.photoOrigins(res.records) : [];
  return { ok: true, res, vehicles, assessments, snapshot, diff, boilerplate, photoOrigins };
}

export const UNSUPPORTED_MESSAGE = unsupportedSiteMessage();

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
  const service = probe.service;
  const search = searchViaTab(tabId, adapter, service);
  let s = settings ? withDefaults(settings, site) : null;
  const out = await scanWithSearch({ adapter, search, site, settings: s || withDefaults({}, site), prevSnapshot: snapshot, posted, options: adapter.scanOptions(service) });
  if (!out.ok) return { ok: false, message: out.message || "Couldn't read this page." };
  let result = out;
  if (!s || settingsFromProfile) {
    if (s && settingsFromProfile) {
      // (whether the profile's dealership part applies here was decided by
      // settingsFromProfile from the website it was saved on)
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
  await rememberSite(origin, { name: site.name, adapter: adapter.PLATFORM.id, service, site: out.snapshot.site, photoOrigins: out.photoOrigins, lastScan: result.res.fetchedAt, lastError: null, auto: Boolean(s.autoRescan) });
  return { ok: true, settings: s, site, service, adapterId: adapter.PLATFORM.id, snapshot: result.snapshot, diff: result.diff, boilerplate: result.boilerplate, vehicles: result.vehicles, res: result.res, photoOrigins: out.photoOrigins };
}

// Sites the extension knows, for background rescans:
// { [origin]: { name, adapter, service, site, photoOrigins, auto, lastScan, lastError, lastNotifiedCount } }
// `service` is the adapter's own data, stored as its probe returned it and
// read only through that adapter (origins, scanOptions, makeDirectSearch).
// `photoOrigins` are the hosts the lot's photos come from: recorded only.
// The key itself is named in src/storageKeys.js; it is re-exported here for
// the callers that always imported it from this module.
export { SITES_KEY };

// One entry merged into the registry under its lock: the popup (auto on or
// off, clearing a website) and the service worker (every rescan's outcome)
// change the same object.
export async function rememberSite(origin, info) {
  const sites = await updateKey(SITES_KEY, (current) => {
    const next = { ...(current || {}) };
    next[origin] = { ...(next[origin] || {}), ...info };
    return next;
  });
  return sites[origin];
}
