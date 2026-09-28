// The dealer-website platforms Lot Sync can read, in the order their in-page
// probes are tried. Each adapter implements the contract in README.md
// (PLATFORM, probeInPage, searchInPage, detect, origins, scanOptions, scan,
// getDetails, normalize, makeDirectSearch, photoOrigins). Only Dealer Inspire
// is built; the others are listed in README.md as TODOs so the next one is
// chosen from demand, not guesswork. Adding a platform: one new file in this
// folder and its line in ADAPTERS (plus a fixture record for the contract
// test in test/adapters.test.js).

import dealerInspire from './dealerInspire.js';

export const ADAPTERS = Object.freeze([dealerInspire]);

export function adapterById(id) {
  return ADAPTERS.find((a) => a.PLATFORM.id === id) || null;
}

// The adapter for a probe from src/scanRunner.js probeTab
// ({ site, service, adapterId }): the one whose in-page probe answered, or
// failing that the one whose detect() recognises the service.
export function detectAdapter(probe) {
  if (!probe) return null;
  if (probe.adapterId) {
    const known = adapterById(probe.adapterId);
    if (known) return known;
  }
  return ADAPTERS.find((a) => a.detect(probe)) || null;
}

// The adapter a stored service belongs to. The site registry keeps the
// service exactly as the adapter's probe returned it, so the adapter is the
// only code that can read it.
export function adapterForService(service) {
  return service ? ADAPTERS.find((a) => a.detect({ service })) || null : null;
}

export function platformNames() {
  return ADAPTERS.map((a) => a.PLATFORM.name);
}

// What the popup and the wizard say on a page no adapter recognises.
export function unsupportedSiteMessage() {
  return `This page doesn't have an inventory search Lot Sync can read (platforms today: ${platformNames().join(', ')}). Open your dealership's used inventory page and try again.`;
}
