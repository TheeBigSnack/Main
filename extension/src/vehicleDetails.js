// Post-time re-check. Fetches ONE car's full record from the dealer website
// (every photo, the description, the features) right before posting, then
// runs the same pre-owned and ready checks again. Belt and braces: a car that
// went sale-pending, sold or got retyped since the last scan can't be posted.

import { scanInventoryInPage } from './scan.js';
import { normalizeVehicle } from './normalize.js';
import { assessVehicle, DECISION } from './classify.js';

export async function fetchVehicleDetails(tabId, vin) {
  const wanted = String(vin || '').toUpperCase();
  let injection;
  try {
    [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: scanInventoryInPage,
      args: [{ vins: [wanted], types: null, fullRecords: true, confirmVins: [] }],
    });
  } catch (e) {
    return { ok: false, message: "Couldn't reach the dealership website tab. Open the used inventory page and click Post again. (" + ((e && e.message) || e) + ')' };
  }
  const res = injection && injection.result;
  if (!res || !res.ok) return { ok: false, message: (res && res.message) || "Couldn't read the dealership website." };
  const raw = res.records.find((r) => r.vin === wanted);
  if (!raw) {
    return { ok: false, notFound: true, message: "This car isn't on the website any more (sold, removed or hidden). Rescan before posting anything." };
  }
  return { ok: true, vehicle: normalizeVehicle(raw), site: res.site, fetchedAt: res.fetchedAt };
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
