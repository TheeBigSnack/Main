// The dealer-website platforms Lot Current can read, in the order their in-page
// probes are tried. Each adapter implements the contract in README.md
// (PLATFORM, probeInPage, searchInPage, detect, origins, scanOptions, scan,
// getDetails, normalize, makeDirectSearch, photoOrigins). Dealer Inspire
// reads its platform's inventory service; schemaOrg reads the standard
// vehicle data any website may publish on its pages; DealerOn and Dealer.com
// read the inventory data their list pages load from the website itself
// (inventoryJson.js, shared). schemaOrg comes last:
// its probe answers on any page that lists cars, so a platform with an
// adapter of its own must be tried first. The platforms still to look at
// are listed in README.md as TODOs, so the next one is chosen from demand,
// not guesswork. Adding a platform: one new file in this folder and its line
// in ADAPTERS, before schemaOrg (plus its entry in PLATFORM_FIXTURES for the
// contract test in test/adapters.test.js).

import dealerInspire from './dealerInspire.js';
import dealerOn from './dealerOn.js';
import dealerCom from './dealerCom.js';
import schemaOrg from './schemaOrg.js';

export const ADAPTERS = Object.freeze([dealerInspire, dealerOn, dealerCom, schemaOrg]);

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

// Whether a reader has been checked on a real dealership website. Only an
// adapter whose PLATFORM says checkedLive: true counts; one that says nothing
// is a reader written from public sources and sample websites, not yet
// confirmed by a survey run on a real site (README.md), and is named only with
// that caveat.
export function isCheckedLive(adapter) {
  return Boolean(adapter && adapter.PLATFORM && adapter.PLATFORM.checkedLive === true);
}

// What the popup and the wizard say on a page no adapter recognises: the
// readers, named by the adapters themselves, split into those checked on a
// real dealership website and those Lot Current only tries.
export function unsupportedSiteMessage() {
  const checked = ADAPTERS.filter(isCheckedLive).map((a) => a.PLATFORM.name);
  const tried = ADAPTERS.filter((a) => !isCheckedLive(a)).map((a) => a.PLATFORM.name);
  const parts = ["Lot Current can't read the cars on this page."];
  if (checked.length) parts.push(`Checked on real dealership websites: ${checked.join('; ')}.`);
  if (tried.length) parts.push(`Also tries, not yet checked on a real dealership website: ${tried.join('; ')}.`);
  parts.push("Open your dealership's used inventory page and try again.");
  return parts.join(' ');
}
