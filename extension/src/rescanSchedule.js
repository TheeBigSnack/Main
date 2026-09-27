// The automatic rescan's small pure pieces: how often, what the badge says,
// when to notify. The service worker (background.js) does the work.

export const RESCAN_ALARM = 'lot-sync-rescan';
export const RESCAN_PERIOD_MINUTES = 180; // every 3 hours while Chrome is open

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
  return { title: 'Lot Sync', message: `${count} of your listings need${count === 1 ? 's' : ''} attention` };
}

export function isDue(lastScanIso, nowIso = new Date().toISOString(), periodMinutes = RESCAN_PERIOD_MINUTES) {
  if (!lastScanIso) return true;
  const last = Date.parse(lastScanIso);
  if (Number.isNaN(last)) return true;
  return Date.parse(nowIso) - last >= periodMinutes * 60 * 1000 - 60 * 1000; // a minute's slack for the alarm
}

// The host-permission patterns a site needs for background rescans: its own
// origin (for the page probe) and its inventory service's origin.
export function originsFor(site, service) {
  const out = new Set();
  const add = (u) => { try { out.add(new URL(u).origin + '/*'); } catch (e) { /* skip */ } };
  if (site && site.origin) add(site.origin);
  if (service && service.search) add(service.search);
  return [...out];
}
