// Everything a scan needs after the records come back, shared by the popup's
// Scan button, the wizard and the background rescan: normalise, assess,
// snapshot, diff, boilerplate. Plus the two ways to reach the inventory
// service from a tab, both through code the adapters own.

import { ADAPTERS, detectAdapter, unsupportedSiteMessage } from '../adapters/index.js';
import { assessVehicle } from './classify.js';
import { makeSnapshot, diffScans } from './rescan.js';
import { findBoilerplate, MIN_BOILERPLATE_COUNT } from './description.js';
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
  const confirmVins = confirmOrder([...new Set([...Object.keys(last), ...Object.keys(posted || {})])], prevSnapshot && prevSnapshot.unchecked);
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
  const carry = { last, previous: prevSnapshot || null, unread: res.unread, confirmVins, confirmUrls };
  const snapshot = snapshotOf({ site: siteForSnapshot(site), res, vehicles, assessments, carry });
  const diff = diffScans(prevSnapshot, snapshot, { posted, confirm: res.confirm, basis: settings.basis });
  if (!res.complete) diff.warnings.unshift(incompleteWarning(res));
  diff.takenAt = res.fetchedAt;
  diff.requests = res.requests;
  // Text that repeats across the lot (disclaimers, legal lines) is kept so the
  // description writer can strip it. A scan that read every car's
  // description works the lines out again from scratch. Any other scan keeps
  // the lines saved from the last one and adds a line only when it is on the
  // share of the whole lot, not of the pages it happened to read:
  //  - a car whose description this scan did not read (res.descriptionsUnread,
  //    an adapter that re-reads only what may have changed, or res.unread, a
  //    car kept from the last snapshot) counts in the lot, so three new
  //    arrivals sharing a sentence never make it a lot-wide line; a car that
  //    simply has no description (a descriptionRaw of null that is not
  //    listed there, such as a list card without dealer comments) is not a
  //    description and counts in neither;
  //  - a scan that did not get the whole list (res.complete false) keeps
  //    the saved lines too, and one whose snapshot is not saved
  //    (diff.unreliable, a website hiccup) is measured against the lot as
  //    last saved, so an empty or near-empty answer never wipes them;
  //  - fewer descriptions than MIN_BOILERPLATE_COUNT can show no line at
  //    all, so the saved ones stay.
  const notRead = new Set(Array.isArray(res.descriptionsUnread) ? res.descriptionsUnread : []);
  const skipped = vehicles.filter((v) => notRead.has(v.vin)).length + (Array.isArray(res.unread) ? res.unread.length : 0);
  const read = vehicles.filter((v) => !notRead.has(v.vin)).map((v) => v.descriptionRaw).filter((d) => d !== null && d !== undefined);
  const saved = Array.isArray(savedBoilerplate) ? savedBoilerplate : [];
  const whole = skipped === 0 && read.length >= MIN_BOILERPLATE_COUNT && res.complete && !diff.unreliable;
  const lot = diff.unreliable ? Math.max(read.length + skipped, (diff.counts && diff.counts.previous) || 0) : read.length + skipped;
  const boilerplate = whole ? [...findBoilerplate(read)] : [...new Set([...saved, ...findBoilerplate(read, undefined, undefined, lot)])];
  // Where this lot's photos are hosted: recorded here; the side panel asks
  // Chrome for a car's photo servers from the salesperson's click (src/photoHosts.js).
  const photoOrigins = typeof adapter.photoOrigins === 'function' ? adapter.photoOrigins(res.records) : [];
  return { ok: true, res, vehicles, assessments, snapshot, diff, boilerplate, photoOrigins, carry };
}

// The cars a scan checks when they are missing, in the order it is to try
// them: those the last scan's check left unchecked (`unchecked`, the last
// snapshot's: their own page failed, or the check stopped before them after
// pages failed in a row) go last, so a few pages that keep failing never hold
// back the other cars' sold check scan after scan, whatever the adapter;
// among those, the reverse of the order the last scan gave them, so the
// ones it never got to come before the pages that failed.
export function confirmOrder(vins, unchecked) {
  const list = Array.isArray(vins) ? vins : [];
  const left = unchecked && typeof unchecked === 'object' ? Object.keys(unchecked).map((v) => v.toUpperCase()) : [];
  if (!left.length) return list;
  const rank = new Map(left.map((vin, n) => [vin, n]));
  const at = (vin) => rank.get(String(vin || '').toUpperCase());
  const first = list.filter((vin) => at(vin) === undefined);
  const last = list.filter((vin) => at(vin) !== undefined).sort((a, b) => at(b) - at(a));
  return [...first, ...last];
}

// The snapshot a scan leaves for the next one. Four things come over from
// the last one. When Lot Current first saw each car (firstSeenAt, rescan.js:
// the last entry's, this scan's time for a car that was not in the last
// snapshot, null on a first scan), so the Ready and To do tabs can mark new
// arrivals for days, not only until the next rescan replaces the diff; the
// last saved snapshot is the one carried from, so a scan whose snapshot is
// not saved (diff.unreliable) changes no dates. When a car's own page was
// last read (pageReadAt: this scan's time for the cars in res.pagesRead,
// else the last entry's), so an adapter that can read only so many pages
// per scan reads the oldest first and gets round the whole lot. A car the
// website still lists but whose details the adapter could not read this
// time (res.unread) keeps its last entry, so a bad server day neither drops
// the car nor changes it. And a car that is not in this scan keeps the page
// it was last seen on (missingPages), so an adapter that checks a missing
// car at its own page can check a posted car again next time, even after
// the car has left the lot's list; with it, when Lot Current first saw that
// car (missingSeen), so a car that comes straight back is not called a
// first sighting (rescan.js firstSeenAt). It also keeps the cars this scan's
// check left unchecked, with why (unchecked), so the next scan checks them
// last (confirmOrder).
function snapshotOf({ site, res, vehicles, assessments, carry }) {
  const snapshot = makeSnapshot({ site, takenAt: res.fetchedAt, complete: res.complete, vehicles, assessments, previous: carry.previous || null });
  const readNow = new Set(Array.isArray(res.pagesRead) ? res.pagesRead : []);
  for (const [vin, entry] of Object.entries(snapshot.vehicles)) {
    const before = carry.last[vin] && carry.last[vin].pageReadAt;
    if (readNow.has(vin)) entry.pageReadAt = res.fetchedAt;
    else if (typeof before === 'string') entry.pageReadAt = before;
  }
  for (const vin of Array.isArray(carry.unread) ? carry.unread : []) {
    if (carry.last[vin] && !snapshot.vehicles[vin]) snapshot.vehicles[vin] = carry.last[vin];
  }
  const missingPages = {};
  const missingSeen = {};
  const seenBefore = (carry.previous && carry.previous.missingSeen) || {};
  for (const vin of carry.confirmVins) {
    if (snapshot.vehicles[vin] || !carry.confirmUrls[vin]) continue;
    missingPages[vin] = carry.confirmUrls[vin];
    const seen = carry.last[vin] ? carry.last[vin].firstSeenAt : seenBefore[vin];
    if (typeof seen === 'string' && seen) missingSeen[vin] = seen;
  }
  if (Object.keys(missingPages).length) snapshot.missingPages = missingPages;
  if (Object.keys(missingSeen).length) snapshot.missingSeen = missingSeen;
  const unchecked = res.confirm && res.confirm.unchecked && typeof res.confirm.unchecked === 'object' ? res.confirm.unchecked : {};
  const left = {};
  for (const [vin, why] of Object.entries(unchecked)) if (!snapshot.vehicles[vin]) left[vin] = typeof why === 'string' ? why.slice(0, 200) : '';
  if (Object.keys(left).length) snapshot.unchecked = left;
  return snapshot;
}

// What a scan that did not read everything says, first on the to-do list.
// Each sentence says only what happened: missing cars were double-checked
// only when the adapter's check ran without an error and checked some (when
// it failed, rescan.js says so on the next line), and pages the adapter's
// page limit left for the next scan (res.leftForLater) were never asked
// for, so they are not called unreadable.
export function incompleteWarning(res) {
  const kept = Array.isArray(res.unread) ? res.unread.length : 0;
  const found = res.records.length + kept;
  const left = Number(res.leftForLater) || 0;
  const c = res.confirm;
  const doubleChecked = c && !c.error && Array.isArray(c.checked) && c.checked.length ? ' Missing cars were looked up again on the website.' : '';
  if (left) {
    const those = left === 1 ? "one car's page was" : `${left} cars' pages were`;
    const shows = kept ? ' A car whose page was not read this time shows what the last scan read.' : '';
    return `This lot has more car pages than one scan reads, so ${those} left for the next scan.${shows}${doubleChecked}`;
  }
  if (found < res.total) return `The website returned ${found} of ${res.total} cars.${doubleChecked}`;
  if (kept === 1) return "One car's page could not be read this time, so that car shows what the last scan read.";
  if (kept) return `${kept} cars' pages could not be read this time, so those cars show what the last scan read.`;
  return `Some of the website's pages could not be read this time.${doubleChecked}`;
}

export const UNSUPPORTED_MESSAGE = unsupportedSiteMessage();

// First-run store choice: the one store that matches the website's own name
// (normalize.js matchStore), never more; none when nothing stands out, so
// the wizard says so and a person picks. The rest of the defaults come from
// withDefaults (name and address from the site's probe).
const defaultStores = (site, stores) => { const mine = matchStore(site, stores); return mine ? [mine] : []; };

/**
 * A full scan from a dealer tab: probe, detect the adapter, read the lot,
 * settle the settings (the website's first scan: defaults from the site, the
 * store named after it ticked even over settings saved before the scan; from
 * the synced profile: keep only store names this website has), assess,
 * diff, remember the site for background rescans. Used by the popup's Scan
 * button and the set-up wizard.
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
  // The website's first scan (no snapshot yet) settles the stores, whatever
  // settings came before it: Settings lists no store until a scan, so
  // settings saved before one (a Save, a sign-in) never chose any.
  if (!s || settingsFromProfile || !snapshot) {
    const stores = storeNames(out.vehicles);
    if (s) {
      // From the synced profile (whether its dealership part applies here was
      // decided by settingsFromProfile from the website it was saved on), or
      // saved before this first scan: only store names this website has.
      const kept = s.myStores.filter((st) => stores.includes(st));
      // An earlier build stored the website's address as the dealership's
      // name when Settings was saved before the first scan; the name the
      // website gives replaces it.
      const dealer = !snapshot && site.host && s.dealer.name === site.host ? { ...s.dealer, name: '' } : s.dealer;
      s = withDefaults({ ...s, dealer, myStores: kept.length ? kept : defaultStores(site, stores) }, site);
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
