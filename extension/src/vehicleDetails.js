// Post-time re-check. Fetches ONE car's full record from the dealer website
// (every photo, the description, the features) right before posting, then
// runs the same pre-owned and ready checks again. Belt and braces: a car that
// went sale-pending, sold or got retyped since the last scan can't be posted.
//
// Two ways to read the car, through the same adapter code:
//   - through the dealer tab (fetchVehicleDetails): the popup's Post button,
//     where the person is on the website; the request is made inside the tab
//     like the page's own (src/scanRunner.js searchViaTab);
//   - straight from the extension (fetchVehicleDetailsDirect): a post started
//     from the side panel's own list, or a tab that was closed or moved on.
//     The adapter's makeDirectSearch sends the same request the automatic
//     rescan sends, and Chrome lets it only with the website permission the
//     set-up wizard asks for (src/panelList.js siteReadOrigins).
// readCarForPost tries the tab first when there is one, and the direct read
// only when the tab can't be used; a car the tab says is gone stays gone.

import { probeTab, searchViaTab, detectAdapter } from './scanRunner.js';
import { adapterById, adapterForService } from '../adapters/index.js';
import { SITES_KEY } from './storageKeys.js';
import { assessVehicle, DECISION } from './classify.js';
import { siteReadOrigins } from './panelList.js';

const errText = (e) => String((e && e.message) || e);
const sentence = (t) => (/[.!?]$/.test(String(t).trim()) ? String(t).trim() : String(t).trim() + '.');
const hostOf = (origin) => {
  try {
    return new URL(origin).host;
  } catch (e) {
    return String(origin || 'the website');
  }
};

// The adapter's answer for one car, as both ways report it.
async function readOne(adapter, search, wanted, options) {
  let r;
  try {
    r = await adapter.getDetails(search, wanted, options);
  } catch (e) {
    return { ok: false, message: "Couldn't read the dealership website: " + errText(e) };
  }
  if (!r.ok) return { ok: false, message: r.message || "Couldn't read the dealership website." };
  if (!r.record) {
    return { ok: false, notFound: true, message: "This car isn't on the website any more (sold, removed or hidden). Rescan before posting anything." };
  }
  return { ok: true, vehicle: adapter.normalize(r.record), fetchedAt: r.fetchedAt };
}

const withUrl = (adapter, service, url) => ({ ...adapter.scanOptions(service), ...(typeof url === 'string' && url ? { url } : {}) });

// `url` is the car's page as the last scan kept it (the snapshot entry's
// url): an adapter that reads the car from its own page starts there; one
// that asks an inventory service ignores it. `origin`, when given, is the
// website the post is for: a tab that now shows another website is not read.
// A tab that can't be used (closed, another page, another website) answers
// with `tabUnusable: true`, so readCarForPost can read the car another way.
export async function fetchVehicleDetails(tabId, vin, { url = null, origin = null } = {}) {
  const wanted = String(vin || '').toUpperCase();
  let probe;
  try {
    probe = await probeTab(tabId);
  } catch (e) {
    return { ok: false, tabUnusable: true, message: "Couldn't reach the dealership website tab. Open the used inventory page and click Post again. (" + errText(e) + ')' };
  }
  const adapter = probe && detectAdapter(probe);
  if (!adapter) return { ok: false, tabUnusable: true, message: "This tab isn't a dealership inventory page Lot Current can read. Open the used inventory page and click Post again." };
  if (origin && probe.site && probe.site.origin && probe.site.origin !== origin) {
    return { ok: false, tabUnusable: true, message: `The dealership tab now shows ${hostOf(probe.site.origin)}, not ${hostOf(origin)}. Open ${hostOf(origin)}'s used inventory page and click Post again.` };
  }
  // What the probe could not see on this page (a car's own page has no
  // inventory list to find) comes from the service the last scan of this
  // website stored, when the same adapter read it; what the probe did see wins.
  const service = await withStoredService(probe, adapter);
  const r = await readOne(adapter, searchViaTab(tabId, adapter, service), wanted, withUrl(adapter, service, url));
  return r.ok ? { ...r, site: probe.site, via: 'tab' } : r;
}

async function withStoredService(probe, adapter) {
  const probed = probe.service || {};
  try {
    const origin = probe.site && probe.site.origin;
    const sites = (await chrome.storage.local.get(SITES_KEY))[SITES_KEY] || {};
    const stored = origin && sites[origin];
    if (!stored || stored.adapter !== adapter.PLATFORM.id || !stored.service || typeof stored.service !== 'object') return probed;
    const seen = Object.fromEntries(Object.entries(probed).filter(([, v]) => v !== null && v !== undefined && v !== ''));
    return { ...stored.service, ...seen };
  } catch (e) {
    return probed;
  }
}

/**
 * The same read without a tab: the website's adapter and service from the
 * site registry (sites[origin]), the adapter's direct search, and Chrome's
 * website permission. Without the permission nothing is sent and the answer
 * says which patterns to ask for (`needsPermission`, `origins`).
 * @param origin   the dealer website's origin
 * @param info     its site registry entry ({ adapter, service, site, name })
 * @param options  url (the car's page from the last snapshot), contains
 *                 (chrome.permissions.contains, replaceable in tests)
 */
export async function fetchVehicleDetailsDirect(origin, info, vin, { url = null, contains = (p) => chrome.permissions.contains(p) } = {}) {
  const wanted = String(vin || '').toUpperCase();
  const host = hostOf(origin);
  if (!info || !info.service) {
    return { ok: false, message: `Lot Current hasn't read ${host} on this computer yet. Open its used inventory page, click Scan website in the popup, then try again.` };
  }
  const adapter = (info.adapter && adapterById(info.adapter)) || adapterForService(info.service);
  if (!adapter) return { ok: false, message: `Lot Current can't read ${host} any more. Open its used inventory page and click Scan website in the popup.` };
  const origins = siteReadOrigins(origin, { ...info, adapter: adapter.PLATFORM.id });
  let granted = false;
  try {
    granted = origins.length > 0 && (await contains({ origins }));
  } catch (e) {
    granted = false;
  }
  if (!granted) {
    return {
      ok: false,
      needsPermission: true,
      origins,
      message: `To re-check this car on ${host} from here, Chrome has to let Lot Current read the website (the same permission automatic rescans use). Click Allow reading ${host}, or open the website's used inventory page and click Post in the popup.`,
    };
  }
  const r = await readOne(adapter, adapter.makeDirectSearch(info.service), wanted, withUrl(adapter, info.service, url));
  if (!r.ok && !r.notFound) return { ...r, message: `${sentence(r.message)} If the website keeps turning Lot Current away, open its used inventory page and click Post in the popup.` };
  return r.ok ? { ...r, site: info.site || { origin, name: info.name || host }, via: 'direct' } : r;
}

/**
 * The post-time read: through the dealer tab when the post started from one
 * and that tab still shows this website; otherwise straight from the
 * extension. A tab that answered (the car, "not on the website any more", a
 * website error) is final: only a tab that can't be used falls through.
 */
export async function readCarForPost({ tabId = null, origin, info = null, vin, url = null, contains } = {}) {
  if (tabId !== null && tabId !== undefined) {
    const r = await fetchVehicleDetails(tabId, vin, { url, origin });
    if (!r.tabUnusable) return r;
    if (!info || !info.service) return r; // nothing else to read it through: the tab's own words
  }
  return fetchVehicleDetailsDirect(origin, info, vin, { url, ...(contains ? { contains } : {}) });
}

// Pure: is this fresh record still allowed into the posting flow?
export function recheck(vehicle, settings = {}) {
  const assessment = assessVehicle(vehicle, settings);
  if (assessment.decision === DECISION.READY) return { ok: true, assessment };
  if (assessment.kind) return { ok: false, assessment, message: assessment.reason };
  const why = {
    [DECISION.SKIP]: "The website now says this is a new vehicle, so it can't go on Marketplace.",
    [DECISION.REVIEW]: 'The website details for this car no longer add up, so it needs a look first.',
    [DECISION.NOT_READY]: "This car isn't ready to post right now.",
  }[assessment.decision];
  return { ok: false, assessment, message: `${why} ${assessment.reason}` };
}
