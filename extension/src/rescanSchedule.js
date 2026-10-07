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
export const SYNC_RETRY_PREFIX = 'sync-retry:';
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

// Due when a period has passed since the last attempt, less five minutes of
// slack: the alarm fires a whole period after the previous firing, but the
// stored time is when the previous scan finished, which can be a minute or
// more later on a large lot. The slack only matters for skipping a site the
// person scanned by hand shortly before the alarm.
export const DUE_SLACK_MS = 5 * 60 * 1000;
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

/**
 * The host-permission patterns a site needs for background rescans: its own
 * origin (for the page probe) plus what its adapter needs to reach the
 * inventory service (adapter.origins(service)).
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
      if (isFacebookServer(u)) facebook = true;
      else out.add(new URL(u).origin + '/' + '*');
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
