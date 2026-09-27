// Settings shared by the popup and the side panel, with defaults so a
// settings object saved by v0.1 ({ myStores, basis }) keeps working.

import { shortLocation } from './normalize.js';
import { DEFAULT_DAILY_CAP } from './cap.js';
import { TITLE_STATUSES, CONDITIONS, DEFAULT_LISTING_DEFAULTS } from './listingData.js';

export const SETTINGS_VERSION = 2;

// The usual gap between the main price and the price before fees (the doc
// fee on most sites), taken from what most cars agree on.
export function feeGap(entries) {
  const priced = (entries || []).filter((e) => e && e.price && e.priceBeforeFees);
  const gaps = new Map();
  for (const e of priced) gaps.set(e.price - e.priceBeforeFees, (gaps.get(e.price - e.priceBeforeFees) || 0) + 1);
  const [gap, count] = [...gaps.entries()].sort((a, b) => b[1] - a[1])[0] || [0, 0];
  const usual = gap > 0 && count >= priced.length * 0.6;
  return { gap: usual ? gap : 0, count, total: priced.length, example: usual ? priced.find((e) => e.price - e.priceBeforeFees === gap) : null };
}

export function suggestedPriceNote(gap, basis = 'website') {
  if (!gap) return '';
  const fee = '$' + Math.round(gap).toLocaleString('en-US');
  return basis === 'beforeFees' ? `Price is before the ${fee} doc fee; tax and tags extra.` : `Price includes the ${fee} doc fee; tax and tags extra.`;
}

export function withDefaults(settings, site = {}) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const myStores = Array.isArray(s.myStores) ? s.myStores.filter(Boolean) : [];
  const sp = s.salesperson || {};
  const d = s.dealer || {};
  const rw = s.rewrite || {};
  const ld = s.defaults || {};
  // '' means "leave blank on the form"; anything unknown falls back to the default
  const pickDefault = (value, allowed, fallback) => (value === '' ? '' : allowed.includes(value) ? value : fallback);
  return {
    version: SETTINGS_VERSION,
    myStores,
    basis: s.basis === 'beforeFees' ? 'beforeFees' : 'website',
    salesperson: { name: String(sp.name || ''), title: String(sp.title || 'sales consultant') },
    // blanks are filled from the website's own address (site.address, read by the scan)
    dealer: {
      name: String(d.name || site.name || ''),
      city: String(d.city || (site.address && site.address.city) || (myStores[0] ? shortLocation(myStores[0]) : '')),
      state: String(d.state || (site.address && site.address.state) || ''),
      zip: String(d.zip || (site.address && site.address.zip) || ''),
    },
    priceNote: typeof s.priceNote === 'string' ? s.priceNote : '',
    dailyCap: Number.isFinite(s.dailyCap) && s.dailyCap > 0 ? Math.floor(s.dailyCap) : DEFAULT_DAILY_CAP,
    rewrite: { enabled: Boolean(rw.enabled), endpoint: String(rw.endpoint || ''), key: String(rw.key || '') },
    // the dealership's answers for the two form fields the website can't give
    defaults: {
      titleStatus: pickDefault(ld.titleStatus, TITLE_STATUSES, DEFAULT_LISTING_DEFAULTS.titleStatus),
      condition: pickDefault(ld.condition, CONDITIONS, DEFAULT_LISTING_DEFAULTS.condition),
    },
  };
}

// The salesperson's own details, kept in chrome.storage.sync so they follow
// the person's Chrome sign-in to any computer and survive clearing one
// website's data or reloading the extension. The rewrite-service key stays
// on this computer only. A real Lot Sync account (shared with the manager,
// across a team) is Milestone 4.
export const PROFILE_KEY = 'profile';

export function profileFrom(settings) {
  const s = withDefaults(settings);
  return {
    salesperson: s.salesperson,
    dealer: s.dealer,
    myStores: s.myStores,
    basis: s.basis,
    priceNote: s.priceNote,
    dailyCap: s.dailyCap,
    defaults: s.defaults,
    rewrite: { enabled: s.rewrite.enabled, endpoint: s.rewrite.endpoint },
    savedAt: new Date().toISOString(),
  };
}

// Settings for a website that has none yet, taken from the saved profile.
// Store names belong to a website, so they only carry over when the dealer
// name matches; otherwise the first scan picks them.
export function settingsFromProfile(profile, site = {}) {
  if (!profile || typeof profile !== 'object') return null;
  const sameDealer = !site.name || !profile.dealer || !profile.dealer.name || profile.dealer.name === site.name;
  return withDefaults({ ...profile, myStores: sameDealer ? profile.myStores : [], rewrite: { ...(profile.rewrite || {}), key: '' } }, site);
}

export async function loadProfile(storage) {
  try {
    const area = storage || chrome.storage.sync;
    return (await area.get(PROFILE_KEY))[PROFILE_KEY] || null;
  } catch (e) {
    return null;
  }
}

export async function saveProfile(settings, storage) {
  try {
    const area = storage || chrome.storage.sync;
    await area.set({ [PROFILE_KEY]: profileFrom(settings) });
    return true;
  } catch (e) {
    return false; // sync storage can be unavailable; the per-website copy still works
  }
}

export function defaultSettings(site, vehicles) {
  const locations = [...new Set((vehicles || []).map((v) => v.location).filter(Boolean))];
  const mine = locations.filter((l) => l === site.name || (site.title || '').includes(l));
  return withDefaults({ myStores: mine, priceNote: suggestedPriceNote(feeGap(vehicles).gap, 'website') }, site);
}
