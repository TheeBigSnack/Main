// Helpers shared by every adapter's normaliser and by the modules that read
// the flat vehicle. The flat shape itself is src/vehicle.js (VEHICLE_FIELDS,
// re-exported here); each platform's record-to-vehicle code lives next to
// its adapter under extension/adapters/ (Dealer Inspire:
// adapters/dealerInspireNormalize.js). Nothing platform-specific lives here,
// and nothing learned from one lot either: the store names below are read
// from each website's own lot every time.

export { VEHICLE_FIELDS } from './vehicle.js';

export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

// The store names a lot's vehicles carry, once each and sorted: what the
// store choice offers and what shortLocation and matchStore judge by.
export function storeNames(vehicles) {
  const names = (vehicles || []).map((v) => v && v.location).filter((l) => typeof l === 'string' && l.trim());
  return [...new Set(names.map((l) => l.trim()))].sort();
}

// Brand words are only a fallback: with one store name to go on (a
// single-store website, or a record read on its own) there is nothing to
// compare it with, so the text after the last brand word is the best guess
// at the store's own part. "Smith Buick GMC" has nothing after its brands
// and keeps its full name.
const BRANDS =
  'Chrysler|Dodge|Jeep|Ram|Fiat|Alfa Romeo|Ford|Lincoln|Chevrolet|Buick|GMC|Cadillac|Toyota|Lexus|Honda|Acura|Nissan|Infiniti|Hyundai|Genesis|Kia|Subaru|Mazda|Volkswagen|Audi|BMW|Mercedes-Benz|Volvo';
const AFTER_BRANDS = new RegExp(`^.*\\b(?:${BRANDS})\\s+(.+)$`, 'i');
const LEADING_BRANDS = new RegExp(`^(?:(?:${BRANDS})\\b\\s*)+`, 'i');

function afterBrands(name) {
  const m = name.match(AFTER_BRANDS);
  return m ? m[1].replace(LEADING_BRANDS, '').trim() : '';
}

// How many leading words every name in the list shares, whole words only:
// "Smith Ford" and "Smith Fiat" share one word ("Smith"), not "Smith F".
function sharedWords(names) {
  const words = names.map((n) => n.split(/\s+/));
  let k = 0;
  while (words.every((w) => w.length > k && w[k].toLowerCase() === words[0][k].toLowerCase())) k += 1;
  return k;
}

/**
 * A store's own part of its name, for labels: "<Group> <brands> Cranberry"
 * -> "Cranberry". Read per website: given the lot's store names
 * (storeNames(vehicles)), the words they all share are the group and brand
 * part and what differs per store is its short name. Brand words are the
 * fallback when there is one store or the names share no prefix. Never
 * empty: a name with nothing to strip is returned whole.
 * @param {string} location  the store name the website gives a car
 * @param {string[]} [allLocations]  every store name on this lot
 */
export function shortLocation(location, allLocations = null) {
  if (!location) return '';
  const name = String(location).trim();
  const lot = [...new Set([name, ...(allLocations || [])].filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim()))];
  let own = '';
  if (lot.length > 1) own = name.split(/\s+/).slice(sharedWords(lot)).join(' ');
  // the store's own part may still open with its brand ("Ford Dayton" beside "Chevrolet Dayton")
  own = afterBrands(own) || own || afterBrands(name);
  own = own.replace(/^(?:of|at|in)\s+/i, '').trim(); // "Smith Chevrolet of Dayton" -> "Dayton"
  return own || name;
}

// Letters and digits only, lower case, so "Ron Lewis CDJR - Waynesburg",
// "RON LEWIS CDJR WAYNESBURG" and the host ronlewiscdjrwaynesburg.com all
// compare on the same footing.
const compact = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// A part this short ("GMC", "Kia") sits inside too many other words to count as found.
const MIN_PART = 4;
const within = (hay, part) => Boolean(hay && part && part.length >= MIN_PART && hay.includes(part));

/**
 * The store to tick for a website that has no settings yet, or null when
 * none stands out (then nothing is ticked and a person picks). Each rule is
 * tried over every store and counts only when exactly one store fits, so a
 * group name that every store carries never ticks them all:
 *   1. the store's name is the website's own name (og:site_name);
 *   2. the website's name, page title or host contains the store's name, or
 *      the store's name contains the website's name;
 *   3. the store's own part (shortLocation over this lot) is the town in the
 *      website's structured-data address, or sits in its name or host.
 * @param {{ name?, title?, host?, address? }} site  from src/scan.js probeSiteInPage
 * @param {string[]} locations  the lot's store names (storeNames(vehicles))
 */
export function matchStore(site, locations) {
  const stores = [...new Set((locations || []).filter((l) => typeof l === 'string' && l.trim()))];
  if (!site || !stores.length) return null;
  const name = compact(site.name);
  const title = compact(site.title);
  const host = compact(site.host);
  const city = compact(site.address && site.address.city);
  const rules = [
    (st) => Boolean(name) && compact(st) === name,
    (st) => [name, title, host].some((t) => within(t, compact(st))) || within(compact(st), name),
    (st) => { const own = compact(shortLocation(st, stores)); return (Boolean(city) && own === city) || within(name, own) || within(host, own); },
  ];
  for (const rule of rules) {
    const hits = stores.filter(rule);
    if (hits.length === 1) return hits[0];
  }
  return null;
}
