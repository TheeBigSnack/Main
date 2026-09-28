// Settings shared by the popup and the side panel, with defaults so a
// settings object saved by v0.1 ({ myStores, basis }) keeps working.

import { shortLocation } from './normalize.js';
import { DEFAULT_DAILY_CAP } from './cap.js';
import { TITLE_STATUSES, CONDITIONS, DEFAULT_LISTING_DEFAULTS } from './listingData.js';

export const SETTINGS_VERSION = 2;
export const DEFAULT_SALESPERSON_TITLE = 'sales consultant';

// The usual gap between the main price and the lower second price a website
// shows (on some sites that is the doc fee), taken from what most cars agree
// on. It is only ever a suggestion: what the gap means is for the dealer to
// say, in the price note, and a person types that note.
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
  const lg = s.legal && typeof s.legal === 'object' ? s.legal : {};
  // '' means "leave blank on the form"; anything unknown falls back to the default
  const pickDefault = (value, allowed, fallback) => (value === '' ? '' : allowed.includes(value) ? value : fallback);
  return {
    version: SETTINGS_VERSION,
    myStores,
    basis: s.basis === 'beforeFees' ? 'beforeFees' : 'website',
    salesperson: { name: String(sp.name || ''), title: String(sp.title || DEFAULT_SALESPERSON_TITLE) },
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
    // automatic rescans (set by the wizard once the host permission is granted) and the desktop notification
    autoRescan: Boolean(s.autoRescan),
    notify: s.notify !== false,
    rulesReadAt: typeof s.rulesReadAt === 'string' ? s.rulesReadAt : '',
    // the edition of the Terms of Service and Privacy Policy the person accepted (src/legalLinks.js LEGAL.version) and when; '' until they do
    legal: { version: typeof lg.version === 'string' ? lg.version : '', acceptedAt: typeof lg.acceptedAt === 'string' ? lg.acceptedAt : '' },
  };
}

// The salesperson's own details, kept in chrome.storage.sync so they follow
// the person's Chrome sign-in to any computer and survive clearing one
// website's data or reloading the extension. The rewrite-service key stays
// on this computer only. A real Lot Sync account (shared with the manager,
// across a team) is Milestone 4.
export const PROFILE_KEY = 'profile';

export function profileFrom(settings, origin = '') {
  const s = withDefaults(settings);
  return {
    origin: String(origin || ''), // the website this profile was saved from (0.4.0); decides whether the dealership part carries over
    salesperson: s.salesperson,
    dealer: s.dealer,
    myStores: s.myStores,
    basis: s.basis,
    priceNote: s.priceNote,
    dailyCap: s.dailyCap,
    defaults: s.defaults,
    rewrite: { enabled: s.rewrite.enabled, endpoint: s.rewrite.endpoint },
    legal: s.legal, // the Terms acceptance is the person's, so it follows them
    savedAt: new Date().toISOString(),
  };
}

// Settings for a website that has none yet, taken from the saved profile.
// The person's own fields (name, role, listing defaults, the Terms acceptance,
// the rewrite service address) follow them anywhere. The dealership's fields (name, address,
// stores, price basis, price note, daily cap) belong to that dealership's
// website: on another dealer's site they are dropped and the website fills
// them. While the site is still unknown (before the first scan) the whole
// profile is kept; performScan settles it once the site name is read.
export function settingsFromProfile(profile, site = {}) {
  if (!profile || typeof profile !== 'object') return null;
  // The website the profile was saved from decides, never the editable dealer
  // name. A profile saved before that was recorded (0.4.0) is kept whole, as
  // before, until it is saved again.
  const sameDealer = !profile.origin || !site.origin || profile.origin === site.origin;
  const person = { salesperson: profile.salesperson, defaults: profile.defaults, legal: profile.legal, rewrite: { ...(profile.rewrite || {}), key: '' } };
  return withDefaults(sameDealer ? { ...profile, ...person } : person, site);
}

// Does this website show, for at least one car, a second price below its main
// price? Only then can "the lower second price" be a basis at all.
export const showsLowerPrice = (entries) => (entries || []).some((e) => e && typeof e.priceBeforeFees === 'number' && e.priceBeforeFees > 0 && typeof e.price === 'number' && e.priceBeforeFees < e.price);

// The basis to store from a Settings save or the wizard's Price step. Without
// a scan to judge by (entries null) the previous choice stands; with one (the
// snapshot's entries, or the wizard's priceStepModel of them), the lower
// price is accepted only when the website shows it.
export function chooseBasis(requested, previous, entries) {
  if (!entries) return previous === 'beforeFees' ? 'beforeFees' : 'website';
  const shown = Array.isArray(entries) ? showsLowerPrice(entries) : Boolean(entries.showsLower);
  return requested === 'beforeFees' && shown ? 'beforeFees' : 'website';
}

// What the wizard's Price step needs from a scan, judged over the same
// snapshot entries Settings judges by: whether the website shows a lower
// second price at all (only then is it offered as a basis), the usual gap,
// and the note that gap suggests for the chosen basis. The example keeps
// only its prices, so the model can sit in the wizard's saved state.
export function priceStepModel(entries, basis = 'website') {
  const fee = feeGap(entries);
  const ex = fee.example;
  return {
    showsLower: showsLowerPrice(entries),
    gap: fee.gap,
    example: ex ? { price: ex.price, priceBeforeFees: ex.priceBeforeFees, priceLabel: String(ex.priceLabel || '') } : null,
    suggested: suggestedPriceNote(fee.gap, basis),
  };
}

export async function loadProfile(storage) {
  try {
    const area = storage || chrome.storage.sync;
    return (await area.get(PROFILE_KEY))[PROFILE_KEY] || null;
  } catch (e) {
    return null;
  }
}

export async function saveProfile(settings, storage, origin = '') {
  try {
    const area = storage || chrome.storage.sync;
    await area.set({ [PROFILE_KEY]: profileFrom(settings, origin) });
    return true;
  } catch (e) {
    return false; // sync storage can be unavailable; the per-website copy still works
  }
}

// First-run defaults: the store matching the site name, the address from the
// website. The price note stays empty: Settings shows the suggested wording
// from the price gap, and a person decides whether it is true for this store.
export function defaultSettings(site, vehicles) {
  const locations = [...new Set((vehicles || []).map((v) => v.location).filter(Boolean))];
  const mine = locations.filter((l) => l === site.name || (site.title || '').includes(l));
  return withDefaults({ myStores: mine }, site);
}
