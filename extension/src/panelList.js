// The side panel's own Ready to post list, so a salesperson can post the
// next car from the panel without going back to the popup or keeping the
// dealership website open in a tab. Pure helpers over the saved snapshot
// (src/rescan.js snapshotEntry), the posted list, the drafts, the settings
// and the site registry (src/scanRunner.js rememberSite). No chrome.*.
//
// The list is the popup's Ready tab: the same cars (ready, not posted), the
// same order (settings.readySort, src/readyList.js), the same search box
// rules and New pill. A car saved as a Facebook draft is listed with no
// Post button: it is finished on Facebook, not posted twice.

import { DECISION } from './classify.js';
import { basisPrice } from './rescan.js';
import { sortOrder, sortEntries, filterText, isNew, newDaysOf, dateLine } from './readyList.js';
import { originsFor } from './rescanSchedule.js';
import { patternCovers, hostList } from './photoHosts.js';

const has = (obj, key) => Boolean(obj) && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);

/**
 * The cars the panel offers, in the order the popup shows them.
 * @param snapshot  the website's saved snapshot ({ takenAt, vehicles })
 * @param options   posted, drafts, settings (readySort, basis, newDays),
 *                  filter (the search box), now
 * @returns {{ total, shown, order, rows: [{ entry, vin, name, price, isNew, line, draft }] }}
 *   total: ready cars not yet posted; shown: those the search box keeps.
 */
export function readyRows(snapshot, { posted = {}, drafts = {}, settings = {}, filter = '', now = Date.now() } = {}) {
  const vehicles = snapshot && snapshot.vehicles && typeof snapshot.vehicles === 'object' ? Object.values(snapshot.vehicles) : [];
  const ready = vehicles.filter((e) => e && e.decision === DECISION.READY && e.vin && !has(posted, e.vin));
  const order = sortOrder(settings && settings.readySort);
  const basis = (settings && settings.basis) || 'website';
  const days = newDaysOf(settings && settings.newDays);
  const shown = sortEntries(ready.filter((e) => filterText(e, filter)), order, { basis });
  return {
    total: ready.length,
    shown: shown.length,
    order,
    rows: shown.map((e) => ({
      entry: e,
      vin: e.vin,
      name: e.name || e.vin,
      price: basisPrice(e, basis),
      isNew: isNew(e, { days, now, posted }),
      line: dateLine(e, { now }),
      draft: has(drafts, e.vin),
    })),
  };
}

/**
 * The cars "Post the next N" queues: the first ones in the order shown that
 * can be posted (drafts are finished on Facebook instead), no more than the
 * day's remaining posts.
 */
export function nextToPost(rows, remaining) {
  const n = Math.max(0, Math.floor(Number(remaining) || 0));
  return (Array.isArray(rows) ? rows : []).filter((r) => r && !r.draft).slice(0, n).map((r) => r.vin);
}

/**
 * The websites the panel can post from: every website in the site registry
 * (one scanned from the popup or set up in the wizard), by name. The registry
 * keeps no snapshot, so a website with nothing saved shows an empty list.
 */
export function siteChoices(sites) {
  return Object.entries(sites && typeof sites === 'object' ? sites : {})
    .filter(([origin, info]) => origin && info && typeof info === 'object')
    .map(([origin, info]) => ({ origin, name: String(info.name || (info.site && info.site.name) || origin) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.origin.localeCompare(b.origin));
}

/**
 * The website the panel opens on: the one it last worked on when that is
 * still known, else the website scanned most recently, else none.
 */
export function defaultOrigin(sites, lastOrigin = null) {
  const all = sites && typeof sites === 'object' ? sites : {};
  if (lastOrigin && has(all, lastOrigin)) return lastOrigin;
  let best = null;
  let bestAt = -Infinity;
  for (const [origin, info] of Object.entries(all)) {
    const at = Date.parse((info && info.lastScan) || '');
    const t = Number.isNaN(at) ? -Infinity : at;
    if (best === null || t > bestAt) {
      best = origin;
      bestAt = t;
    }
  }
  return best || lastOrigin || null;
}

/**
 * The host permissions reading this website straight from the extension
 * needs (the same ones the automatic rescan uses: the website itself and its
 * inventory service, as its adapter names them), or [] for a website the
 * registry has no service for.
 */
export function siteReadOrigins(origin, info) {
  if (!origin || !info || !info.service) return [];
  return originsFor({ origin, adapter: info.adapter || null }, info.service);
}

/**
 * What the side panel says before Chrome's prompt for reading the website:
 * every host it is about to ask for (`patterns`, the ones not granted yet),
 * as Chrome's prompt will list them. A Dealer Inspire website's inventory
 * service is one of them, so the sentence names it too.
 */
export function siteAskText(patterns) {
  return `Chrome will ask to let Lot Current read ${hostList(patterns) || 'the website'} from the side panel (the same permission automatic rescans use).`;
}

/**
 * Which of `needed` (patterns like https://host/*) the granted list
 * (chrome.permissions.getAll().origins, the manifest's host permissions
 * included) does not cover. Only https is checked here; anything else is
 * reported missing, and Chrome's own request answers yes without a prompt
 * when it is in fact covered.
 */
export function missingOrigins(needed, granted) {
  const have = Array.isArray(granted) ? granted : [];
  return (Array.isArray(needed) ? needed : []).filter((p) => {
    const address = String(p).replace(/\*$/, '');
    return !have.some((g) => patternCovers(g, address));
  });
}
