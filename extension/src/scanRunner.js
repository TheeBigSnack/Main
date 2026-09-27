// Everything a scan needs after the records come back, shared by the popup's
// Scan button and the background rescan: normalise, assess, snapshot, diff,
// boilerplate. Plus the two ways to reach the inventory service from a tab.

import { detectAdapter } from '../adapters/index.js';
import { assessVehicle } from './classify.js';
import { makeSnapshot, diffScans } from './rescan.js';
import { findBoilerplate } from './description.js';
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
