// Post-time re-check. Fetches ONE car's full record from the dealer website
// (every photo, the description, the features) right before posting, then
// runs the same pre-owned and ready checks again. Belt and braces: a car that
// went sale-pending, sold or got retyped since the last scan can't be posted.

import { probeTab, searchViaTab, detectAdapter } from './scanRunner.js';
import { SITES_KEY } from './storageKeys.js';
import { assessVehicle, DECISION } from './classify.js';

// `url` is the car's page as the last scan kept it (the snapshot entry's
// url): an adapter that reads the car from its own page starts there; one
// that asks an inventory service ignores it.
export async function fetchVehicleDetails(tabId, vin, { url = null } = {}) {
  const wanted = String(vin || '').toUpperCase();
  let probe;
  try {
    probe = await probeTab(tabId);
  } catch (e) {
    return { ok: false, message: "Couldn't reach the dealership website tab. Open the used inventory page and click Post again. (" + ((e && e.message) || e) + ')' };
  }
  const adapter = probe && detectAdapter(probe);
  if (!adapter) return { ok: false, message: "This tab isn't a dealership inventory page Lot Current can read. Open the used inventory page and click Post again." };
  // What the probe could not see on this page (a car's own page has no
  // inventory list to find) comes from the service the last scan of this
  // website stored, when the same adapter read it; what the probe did see wins.
  const service = await withStoredService(probe, adapter);
  let r;
  try {
    const options = { ...adapter.scanOptions(service), ...(typeof url === 'string' && url ? { url } : {}) };
    r = await adapter.getDetails(searchViaTab(tabId, adapter, service), wanted, options);
  } catch (e) {
    return { ok: false, message: "Couldn't read the dealership website: " + ((e && e.message) || e) };
  }
  if (!r.ok) return { ok: false, message: r.message || "Couldn't read the dealership website." };
  if (!r.record) {
    return { ok: false, notFound: true, message: "This car isn't on the website any more (sold, removed or hidden). Rescan before posting anything." };
  }
  return { ok: true, vehicle: adapter.normalize(r.record), site: probe.site, fetchedAt: r.fetchedAt };
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
