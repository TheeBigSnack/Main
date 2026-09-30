// Post-time re-check. Fetches ONE car's full record from the dealer website
// (every photo, the description, the features) right before posting, then
// runs the same pre-owned and ready checks again. Belt and braces: a car that
// went sale-pending, sold or got retyped since the last scan can't be posted.

import { probeTab, searchViaTab, detectAdapter } from './scanRunner.js';
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
  if (!adapter) return { ok: false, message: "This tab isn't a dealership inventory page Lot Sync can read. Open the used inventory page and click Post again." };
  let r;
  try {
    const options = { ...adapter.scanOptions(probe.service), ...(typeof url === 'string' && url ? { url } : {}) };
    r = await adapter.getDetails(searchViaTab(tabId, adapter, probe.service), wanted, options);
  } catch (e) {
    return { ok: false, message: "Couldn't read the dealership website: " + ((e && e.message) || e) };
  }
  if (!r.ok) return { ok: false, message: r.message || "Couldn't read the dealership website." };
  if (!r.record) {
    return { ok: false, notFound: true, message: "This car isn't on the website any more (sold, removed or hidden). Rescan before posting anything." };
  }
  return { ok: true, vehicle: adapter.normalize(r.record), site: probe.site, fetchedAt: r.fetchedAt };
}

// Pure: is this fresh record still allowed into the posting flow?
export function recheck(vehicle, settings = {}) {
  const assessment = assessVehicle(vehicle, settings);
  if (assessment.decision === DECISION.READY) return { ok: true, assessment };
  const why = {
    [DECISION.SKIP]: "The website now says this is a new vehicle, so it can't go on Marketplace.",
    [DECISION.REVIEW]: 'The website details for this car no longer add up, so it needs a look first.',
    [DECISION.NOT_READY]: "This car isn't ready to post right now.",
  }[assessment.decision];
  return { ok: false, assessment, message: `${why} ${assessment.reason}` };
}
