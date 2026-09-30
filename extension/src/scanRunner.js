// Everything a scan needs after the records come back, shared by the popup's
// Scan button, the wizard and the background rescan: normalise, assess,
// snapshot, diff, boilerplate. Plus the two ways to reach the inventory
// service from a tab, both through code the adapters own.

import { ADAPTERS, detectAdapter, unsupportedSiteMessage } from '../adapters/index.js';
import { assessVehicle } from './classify.js';
import { makeSnapshot, diffScans } from './rescan.js';
import { findBoilerplate } from './description.js';
import { withDefaults } from './settings.js';
import { storeNames, shortLocation, matchStore } from './normalize.js';
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
 *   prevSnapshot, posted, options (adapter.scanOptions(service), optional),
 *   boilerplate (the lot-wide lines saved from the last scan, optional)
 */
export async function scanWithSearch({ adapter, search, site, settings, prevSnapshot = null, posted = {}, options = null, boilerplate: savedBoilerplate = [] }) {
  const last = (prevSnapshot && prevSnapshot.vehicles) || {};
  const confirmVins = [...new Set([...Object.keys(last), ...Object.keys(posted || {})])];
  // Where each car was last seen, for an adapter that checks a missing car
  // at its own page; the last read and the posted list, for one that reads
  // only what may have changed. An adapter that needs none of it ignores it.
  const confirmUrls = { ...((prevSnapshot && prevSnapshot.missingPages) || {}) };
  for (const [vin, entry] of Object.entries(last)) if (entry && typeof entry.url === 'string' && entry.url) confirmUrls[vin] = entry.url;
  const res = await adapter.scan(search, { ...(options || {}), confirmVins, confirmUrls, lastSeen: last, postedVins: Object.keys(posted || {}) });
  if (!res.ok) return { ok: false, message: res.message, res };
  const vehicles = res.records.map(adapter.normalize).filter(Boolean);
  // The adapter's normalise sees one record, so its store label is a guess
  // from brand words; over the whole lot, what differs between this
  // website's store names is each store's own part (read here every scan,
  // never baked in).
  const stores = storeNames(vehicles);
  for (const v of vehicles) v.locationShort = shortLocation(v.location, stores);
  const assessments = vehicles.map((v) => assessVehicle(v, settings));
  const carry = { last, unread: res.unread, confirmVins, confirmUrls };
  const snapshot = snapshotOf({ site: siteForSnapshot(site), res, vehicles, assessments, carry });
  const diff = diffScans(prevSnapshot, snapshot, { posted, confirm: res.confirm, basis: settings.basis });
  if (!res.complete) diff.warnings.unshift(incompleteWarning(res));
  diff.takenAt = res.fetchedAt;
  diff.requests = res.requests;
  // Text that repeats across the lot (disclaimers, legal lines) is kept so the
  // description writer can strip it. A descriptionRaw of null is a car whose
  // description this scan did not read (an adapter that re-reads only what
  // may have changed): the lines found before are kept next to what the
  // descriptions read this time show.
  const read = vehicles.map((v) => v.descriptionRaw).filter((d) => d !== null);
  const found = findBoilerplate(read);
  const boilerplate = read.length < vehicles.length ? [...new Set([...(Array.isArray(savedBoilerplate) ? savedBoilerplate : []), ...found])] : [...found];
  // Where this lot's photos are hosted: recorded here; the side panel asks
  // Chrome for a car's photo servers from the salesperson's click (src/photoHosts.js).
  const photoOrigins = typeof adapter.photoOrigins === 'function' ? adapter.photoOrigins(res.records) : [];
  return { ok: true, res, vehicles, assessments, snapshot, diff, boilerplate, photoOrigins, carry };
}

// The snapshot a scan leaves for the next one. Two things come over from
// the last one. A car the website still lists but whose details the adapter
// could not read this time (res.unread) keeps its last entry, so a bad
// server day neither drops the car nor changes it. And a car that is not in
// this scan keeps the page it was last seen on (missingPages), so an adapter
// that checks a missing car at its own page can check a posted car again
// next time, even after the car has left the lot's list.
function snapshotOf({ site, res, vehicles, assessments, carry }) {
  const snapshot = makeSnapshot({ site, takenAt: res.fetchedAt, complete: res.complete, vehicles, assessments });
  for (const vin of Array.isArray(carry.unread) ? carry.unread : []) {
    if (carry.last[vin] && !snapshot.vehicles[vin]) snapshot.vehicles[vin] = carry.last[vin];
  }
  const missingPages = {};
  for (const vin of carry.confirmVins) if (!snapshot.vehicles[vin] && carry.confirmUrls[vin]) missingPages[vin] = carry.confirmUrls[vin];
  if (Object.keys(missingPages).length) snapshot.missingPages = missingPages;
  return snapshot;
}

// What a scan that did not read everything says, first on the to-do list.
export function incompleteWarning(res) {
  const kept = Array.isArray(res.unread) ? res.unread.length : 0;
  const found = res.records.length + kept;
  if (found < res.total) return `The website returned ${found} of ${res.total} cars. Missing cars were double-checked one by one.`;
  if (kept === 1) return "One car's page could not be read this time, so that car shows what the last scan read.";
  if (kept) return `${kept} cars' pages could not be read this time, so those cars show what the last scan read.`;
  return 'Some of the website\'s pages could not be read this time. Missing cars were double-checked one by one.';
}

export const UNSUPPORTED_MESSAGE = unsupportedSiteMessage();

// First-run store choice: the one store that matches the website's own name
// (normalize.js matchStore), never more; none when nothing stands out, so
// the wizard says so and a person picks. The rest of the defaults come from
// withDefaults (name and address from the site's probe).
const defaultStores = (site, stores) => { const mine = matchStore(site, stores); return mine ? [mine] : []; };

/**
 * A full scan from a dealer tab: probe, detect the adapter, read the lot,
 * settle the settings (first scan: defaults from the site; from the synced
 * profile: keep only store names this website has), assess, diff, remember
 * the site for background rescans. Used by the popup's Scan button and the
 * set-up wizard.
 */
export async function performScan({ tabId, origin, settings = null, settingsFromProfile = false, snapshot = null, posted = {}, boilerplate = [] }) {
  const probe = await probeTab(tabId);
  const adapter = probe && detectAdapter(probe);
  if (!adapter) return { ok: false, message: UNSUPPORTED_MESSAGE };
  const site = { ...probe.site, adapter: adapter.PLATFORM.id };
  const service = probe.service;
  const search = searchViaTab(tabId, adapter, service);
  let s = settings ? withDefaults(settings, site) : null;
  const out = await scanWithSearch({ adapter, search, site, settings: s || withDefaults({}, site), prevSnapshot: snapshot, posted, options: adapter.scanOptions(service), boilerplate });
  if (!out.ok) return { ok: false, message: out.message || "Couldn't read this page." };
  let result = out;
  if (!s || settingsFromProfile) {
    const stores = storeNames(out.vehicles);
    if (s && settingsFromProfile) {
      // (whether the profile's dealership part applies here was decided by
      // settingsFromProfile from the website it was saved on)
      const kept = s.myStores.filter((st) => stores.includes(st));
      s = withDefaults({ ...s, myStores: kept.length ? kept : defaultStores(site, stores) }, site);
    } else {
      s = withDefaults({ myStores: defaultStores(site, stores) }, site);
    }
    // the store choice changes what is "ready": assess again with the real settings (no second request)
    const assessments = out.vehicles.map((v) => assessVehicle(v, s));
    const snap = snapshotOf({ site: out.snapshot.site, res: out.res, vehicles: out.vehicles, assessments, carry: out.carry });
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
// `photoOrigins` are the hosts the lot's photos come from, as the last scan saw them.
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
