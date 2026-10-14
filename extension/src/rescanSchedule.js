// The automatic rescan's small pure pieces: how often, what the badge says,
// when to notify, which hosts it needs. The service worker (background.js)
// does the work.

import { adapterById, adapterForService } from '../adapters/index.js';
import { isFacebookServer } from './photoHosts.js';

export const RESCAN_ALARM = 'lot-sync-rescan';
export const RESCAN_PERIOD_MINUTES = 180; // every 3 hours while Chrome is open

// A sync the account server turned away for coming too often (its per-person
// brake counts the last minute) is tried again a minute later, by a
// one-shot alarm named after the website: one per website, so a second
// refusal moves it rather than adding another.
const SYNC_RETRY_PREFIX = 'sync-retry:';
export const SYNC_RETRY_MINUTES = 1;
export const syncRetryAlarm = (origin) => SYNC_RETRY_PREFIX + String(origin || '');

// The website a retry alarm is for; null for any other alarm.
export function originOfSyncRetryAlarm(name) {
  const n = String(name || '');
  return n.startsWith(SYNC_RETRY_PREFIX) && n.length > SYNC_RETRY_PREFIX.length ? n.slice(SYNC_RETRY_PREFIX.length) : null;
}

// The salesperson's own to-do count from a diff: take-downs, price updates
// and needs-a-look items on cars they posted.
export function todoCountFor(diff) {
  if (!diff) return 0;
  const yours = (list) => (Array.isArray(list) ? list.filter((x) => x && x.yours).length : 0);
  return yours(diff.takeDown) + yours(diff.priceUpdates) + yours(diff.needsALook);
}

export function badgeText(count) {
  return count > 0 ? String(Math.min(count, 99)) : '';
}

// A desktop notification only when the count went up since the last one.
export function notificationFor(previousCount, count) {
  const prev = Number(previousCount) || 0;
  if (!(count > 0) || count <= prev) return null;
  return { title: 'Lot Current', message: `${count} of your listings need${count === 1 ? 's' : ''} attention` };
}

// The count a site records as told about, after a scan. A notice the system
// refused to show (failed) is not recorded, so the next scan makes it again;
// otherwise the count is what the scan found.
export function notifiedAfter(previous, count, failed) {
  return failed ? (Number(previous) || 0) : count;
}

// The count a site was told about, lowered when to-do items are handled
// between scans (the popup, the side panel or Upkeep clear them, and the
// badge follows). Without this, a car sold after the clear is compared with
// the old, higher count and its notice is never shown. Null when there is
// nothing to lower: a rise is recorded by the scan, not here.
export function toldCountAfterChange(told, count) {
  return count < (Number(told) || 0) ? count : null;
}

// Due when a period has passed since the last attempt, less five minutes of
// slack: the alarm fires a whole period after the previous firing, but the
// stored time is when the previous scan finished, which can be a minute or
// more later on a large lot. The slack only matters for skipping a site the
// person scanned by hand shortly before the alarm.
const DUE_SLACK_MS = 5 * 60 * 1000;
export function isDue(lastIso, nowIso = new Date().toISOString(), periodMinutes = RESCAN_PERIOD_MINUTES) {
  if (!lastIso) return true;
  const last = Date.parse(lastIso);
  if (Number.isNaN(last)) return true;
  return Date.parse(nowIso) - last >= periodMinutes * 60 * 1000 - DUE_SLACK_MS;
}

// The most recent of several ISO timestamps (missing or unparsable ones are ignored).
export function latestOf(...isos) {
  let best = null;
  for (const iso of isos) {
    if (!iso || Number.isNaN(Date.parse(iso))) continue;
    if (!best || Date.parse(iso) > Date.parse(best)) best = iso;
  }
  return best;
}

// This computer's own address: the browser tests' mock sites run on it, and a
// dealership is never there. Chrome grants the automatic check only for https
// websites (the manifest's optional host permission is https only).
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;

/** True for a dealership website the automatic check cannot be granted for: plain http, not this computer. */
export function httpOnlyWebsite(origin) {
  try {
    const url = new URL(String(origin));
    return url.protocol === 'http:' && !LOOPBACK.test(url.hostname);
  } catch (e) {
    return false;
  }
}

/**
 * The host-permission patterns a site needs for background rescans: its own
 * origin (for the page probe) plus what its adapter needs to reach the
 * inventory service (adapter.origins(service)). Only https origins are
 * named, and this computer's own address; an http dealer site gets none of
 * its own (httpOnlyWebsite says so to the person).
 * @param site  { origin, adapter? }
 * @param needs either the adapter's list (adapter.origins(service)) or, as
 *   the wizard and the popup pass it, the site's stored service: then the
 *   adapter named on the site (or the one that recognises the service) is
 *   asked, so nothing here reads the service itself.
 * Never one of Facebook's servers (photoHosts.js isFacebookServer): when the
 * site record or its service names one, the list is empty, so nothing asks
 * Chrome for a Facebook host and the background rescan's permission check
 * (background.js hasPermission) says no. Lot Current reads the dealer's
 * website, never Facebook.
 */
export function originsFor(site, needs) {
  const out = new Set();
  let facebook = false;
  // the pattern's '/' + '*' is split so the guard test's comment stripper never sees a block-comment opener
  const add = (u) => {
    try {
      const url = new URL(u);
      if (isFacebookServer(u)) facebook = true;
      else if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.test(url.hostname))) out.add(url.origin + '/' + '*');
    } catch (e) { /* skip */ }
  };
  if (site && site.origin) add(site.origin);
  let list = needs;
  if (list && !Array.isArray(list) && typeof list === 'object') {
    const adapter = (site && site.adapter && adapterById(site.adapter)) || adapterForService(list);
    list = adapter ? adapter.origins(list) : [];
  }
  for (const pattern of Array.isArray(list) ? list : []) add(pattern);
  return facebook ? [] : [...out];
}

// The registry with one website's entry given these fields. Undefined when the
// website is not registered any more: a result that lands after Clear
// everything for this website must not register it again (review U3).
export function withSiteFields(sites, origin, fields) {
  if (!sites || !sites[origin]) return undefined;
  return { ...sites, [origin]: { ...sites[origin], ...fields } };
}
