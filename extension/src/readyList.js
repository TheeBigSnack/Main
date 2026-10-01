// The Ready to post list's order, its search box and what "new" means: pure
// helpers over snapshot entries (src/rescan.js snapshotEntry). No chrome.*.
//
// A car's date on the lot comes from the website when it gives one
// (dateInStock, kept in the snapshot), else from the scan that first saw the
// car (firstSeenAt, carried from one snapshot to the next; null for a car
// that was already on the website at Lot Current's first scan). The date keeps
// its source and the words say which: "on the website since ..." may count
// days on the lot, "Lot Current first saw it ..." never does, because the car
// may have sat on the lot long before Lot Current looked. Nothing here guesses
// a date: a car with neither is not new and sorts after the dated ones.

import { basisPrice } from './rescan.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_NEW_DAYS = 7;
export const MIN_NEW_DAYS = 1;
export const MAX_NEW_DAYS = 30;

export const SORT_ORDERS = Object.freeze([
  Object.freeze({ id: 'newest', label: 'Newest on the lot' }),
  Object.freeze({ id: 'longest', label: 'Longest on the lot' }),
  Object.freeze({ id: 'price', label: 'Price, low to high' }),
  Object.freeze({ id: 'name', label: 'Name' }),
]);
export const DEFAULT_SORT = 'newest';

// A sort order id as stored, or the default for anything else.
export const sortOrder = (id) => (SORT_ORDERS.some((o) => o.id === id) ? id : DEFAULT_SORT);

// How many days a car counts as new: a whole number from 1 to 30; anything
// else (nothing saved yet, a 0, text) is the default.
export function newDaysOf(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < MIN_NEW_DAYS) return DEFAULT_NEW_DAYS;
  return Math.min(MAX_NEW_DAYS, n);
}

// A website's in-stock date is a calendar date with no time of day, however
// it is spelled: ISO midnight UTC in any of its forms ("2026-09-20",
// "2026-09-20T00:00:00.000Z", "2026-09-20T00:00:00+00:00", "2026-09-20T00:00Z")
// or a bare month/day/year ("09/20/2026"). The first sighting is a moment.
// The two are shown and counted differently (shortDate, ageDays), so the
// spelling never moves the date by a day west of UTC.
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00))?$/;
const SLASH_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

// Midnight UTC of a year, month and day, or null when they do not name a real
// day (a 30 February, a 13th month, "24/09/2026" read as month/day): no date,
// never a guess at what was meant.
function utcDay(year, month, day) {
  const at = Date.UTC(year, month - 1, day);
  const d = new Date(at);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? at : null;
}

function parse(value, { calendar = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (calendar) {
    const iso = DATE_ONLY.exec(text);
    const mdy = iso ? null : SLASH_DATE.exec(text);
    if (iso || mdy) {
      const at = iso ? utcDay(+iso[1], +iso[2], +iso[3]) : utcDay(+mdy[3], +mdy[1], +mdy[2]);
      return at === null ? null : { at, dateOnly: true };
    }
  }
  const at = Date.parse(text);
  return Number.isFinite(at) ? { at, dateOnly: false } : null;
}

/**
 * When the car came onto the lot, as far as anything knows:
 * { at (ms), source: 'website' | 'lotSync', dateOnly }, or null when
 * neither the website nor a scan says (the car was already there when Lot
 * Current first scanned the website, or the saved entry predates the dates).
 * Only the website's date can be a calendar date; a sighting is a moment,
 * even one that fell on midnight.
 */
export function lotDate(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const site = parse(entry.dateInStock, { calendar: true });
  if (site) return { ...site, source: 'website' };
  const seen = parse(entry.firstSeenAt);
  if (seen) return { ...seen, source: 'lotSync' };
  return null;
}

// Midnight UTC of the person's local calendar day, so a website's calendar
// date is counted against the day the person is in, not against the clock.
const localDayUtc = (now) => { const d = new Date(now); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); };

// How long ago the date is, in days: whole calendar days for a website's
// date, a fraction of days for a moment. Null without a date.
export function ageDays(entry, now = Date.now()) {
  const d = lotDate(entry);
  if (!d) return null;
  if (d.dateOnly) return Math.max(0, Math.round((localDayUtc(now) - d.at) / DAY_MS));
  return Math.max(0, (now - d.at) / DAY_MS);
}

// Days on the lot: only from the website's own date (a first sighting says
// nothing about how long the car had been there). Null otherwise.
export function daysOnLot(entry, now = Date.now()) {
  const d = lotDate(entry);
  if (!d || d.source !== 'website') return null;
  return Math.floor(ageDays(entry, now));
}

/**
 * New: on the lot no longer than `days` ago, by the website's date or else
 * by the first sighting. A posted car is never new, whatever its date, and a
 * car with no date is not new. A date in the future (the website's clock,
 * or its midnight-UTC date read the evening before) counts as within the window.
 * @param {object} options  days (the setting), now (ms), posted (the posted registry)
 */
export function isNew(entry, { days = DEFAULT_NEW_DAYS, now = Date.now(), posted = {} } = {}) {
  if (!entry || typeof entry !== 'object') return false;
  if (posted && typeof posted === 'object' && Object.prototype.hasOwnProperty.call(posted, entry.vin)) return false;
  const age = ageDays(entry, now);
  return age !== null && age <= newDaysOf(days);
}

// The date in the person's locale, short: "Sep 20", with the year when it is
// not this year. A website's calendar date is shown as the website wrote it.
export function shortDate(when, { now = Date.now(), locale = undefined, dateOnly = false } = {}) {
  const d = new Date(when);
  const opts = { month: 'short', day: 'numeric' };
  if (dateOnly) opts.timeZone = 'UTC';
  const year = dateOnly ? d.getUTCFullYear() : d.getFullYear();
  if (year !== new Date(now).getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(locale, opts);
}

// The one line under a car: its date and where the date came from.
export function dateLine(entry, { now = Date.now(), locale = undefined } = {}) {
  if (!entry || typeof entry !== 'object') return '';
  const d = lotDate(entry);
  if (!d) return 'no date on the website, and Lot Current did not see it arrive';
  const when = shortDate(d.at, { now, locale, dateOnly: d.dateOnly });
  if (d.source === 'lotSync') return `Lot Current first saw it ${when}`;
  const n = daysOnLot(entry, now);
  const onLot = n === 0 ? 'under a day on the lot' : `${n} day${n === 1 ? '' : 's'} on the lot`;
  return `on the website since ${when} · ${onLot}`;
}

// The search box: every typed word must match the stock number, the end of
// the VIN (six characters or more) or the start of a word of the car's name
// (year, make, model, trim), case-insensitively. Punctuation is ignored on
// both sides, so "f150" finds an F-150. No text matches everything.
export function filterText(entry, text) {
  const terms = String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  if (!entry || typeof entry !== 'object') return false;
  const bare = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const stock = String(entry.stock || '').toLowerCase();
  const vin = String(entry.vin || '').toLowerCase();
  const words = String(entry.name || '').toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((term) => {
    const flat = bare(term);
    if (stock && (stock.includes(term) || (flat && bare(stock).includes(flat)))) return true;
    if (term.length >= 6 && vin.endsWith(term)) return true;
    return words.some((w) => w.startsWith(term) || (flat && bare(w).startsWith(flat)));
  });
}

// A date's place in the two date orders: a moment as it is; a website's
// calendar date at the person's own midnight of that day, the day ageDays
// counts it in, so "on the website since Sep 30" sorts as newer than a
// sighting on the evening of Sep 29 in every time zone, as the lines read.
const sortKey = (d) => {
  if (!d.dateOnly) return d.at;
  const u = new Date(d.at);
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate()).getTime();
};

const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || '')) || String(a.vin || '').localeCompare(String(b.vin || ''));

/**
 * The comparator for one order. Both date orders put cars with no date after
 * the dated ones; the price order puts cars with no price last; every order
 * ends with the name, then the VIN, so two equal cars keep one order.
 * @param {string} order  one of SORT_ORDERS (anything else: the default)
 * @param {object} options  basis: the price basis (rescan.js basisPrice)
 */
export function compareEntries(order, { basis = 'website' } = {}) {
  const id = sortOrder(order);
  if (id === 'name') return byName;
  if (id === 'price') {
    return (a, b) => {
      const pa = basisPrice(a, basis);
      const pb = basisPrice(b, basis);
      const hasA = typeof pa === 'number' && pa > 0;
      const hasB = typeof pb === 'number' && pb > 0;
      if (hasA !== hasB) return hasA ? -1 : 1;
      if (hasA && pa !== pb) return pa - pb;
      return byName(a, b);
    };
  }
  const direction = id === 'newest' ? -1 : 1;
  return (a, b) => {
    const da = lotDate(a);
    const db = lotDate(b);
    if (Boolean(da) !== Boolean(db)) return da ? -1 : 1;
    if (da) {
      const ka = sortKey(da);
      const kb = sortKey(db);
      if (ka !== kb) return direction * (ka - kb);
    }
    return byName(a, b);
  };
}

export function sortEntries(entries, order, options = {}) {
  return [...(Array.isArray(entries) ? entries : [])].sort(compareEntries(order, options));
}

// The cars isNew says are new, newest first.
export function newCars(entries, options = {}) {
  return sortEntries((Array.isArray(entries) ? entries : []).filter((e) => isNew(e, options)), 'newest', options);
}
