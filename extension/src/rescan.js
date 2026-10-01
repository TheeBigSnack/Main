// Rescan: compares this scan of the website with the last one, and with the
// cars the salesperson has marked as posted, and turns the differences into
// a to-do list:
//   - take down: cars gone from the website (confirmed by a direct VIN lookup)
//                and posted cars that went sale-pending
//   - update price: website price went up or down since it was posted / last seen
//   - new arrivals: cars on the website that weren't there last time
//   - now ready: cars that just got photos, a price, arrived on the lot, etc.
//   - needs a look: anything ambiguous (price removed, unconfirmed disappearance)
//
// A car is only called gone when the website's own search can't find its VIN.
// If more than half the lot disappears at once, nothing is marked gone: that
// is almost always a website hiccup, not a sales record.

import { DECISION } from './classify.js';

export const MASS_DISAPPEARANCE_SHARE = 0.5;

// The price to post. 'beforeFees' means the lower second price the website
// shows; when this car has none below its main price, the main price is used
// (a price that is not on the website is never posted).
export function basisPrice(v, basis = 'website') {
  if (!v) return null;
  const main = typeof v.price === 'number' ? v.price : null;
  const lower = typeof v.priceBeforeFees === 'number' && v.priceBeforeFees > 0 ? v.priceBeforeFees : null;
  if (basis !== 'beforeFees') return main;
  if (lower !== null && (main === null || lower < main)) return lower;
  return main;
}

export const PRICE_BASES = Object.freeze(['website', 'beforeFees']);

// The price basis a posted listing carries, so its price is compared with
// the website's price on that same basis: the dealer switching Settings
// (Price to post) never makes a price change the website didn't make
// (rule 4). markPosted records it on the entry. An entry without one
// (posted before it was recorded, or brought by a sync: the server doesn't
// keep it) carries the basis whose website price equals its own on the last
// scan, else on this one (`seen`, oldest first). When both bases give the
// car that price, or neither does, the current setting (`basis`) stands:
// a listing price that is on no basis is compared as before.
export function listingBasis(entry, seen = [], basis = 'website') {
  if (entry && PRICE_BASES.includes(entry.basis)) return entry.basis;
  const price = entry && typeof entry.price === 'number' ? entry.price : null;
  if (price === null) return basis;
  for (const v of seen) {
    if (!v) continue;
    const matches = PRICE_BASES.filter((b) => basisPrice(v, b) === price);
    if (matches.length === 1) return matches[0];
    if (matches.length) return basis;
  }
  return basis;
}

// The website's price now for a posted listing, on the basis the listing
// carries (listingBasis): what Update price and My listings compare with the
// listed price, and what Updated records, so a switch of Price to post never
// reads as a price change in either place. `seen`: the scans the basis of an
// entry without one is read from, oldest first (by default this one).
export function listingWebsitePrice(entry, now, basis = 'website', seen = [now]) {
  return basisPrice(now, listingBasis(entry, seen, basis));
}

// The compact per-car record kept between scans.
export function snapshotEntry(v, assessment) {
  return {
    vin: v.vin,
    name: v.name,
    stock: v.stock,
    url: v.url,
    price: v.price,
    priceLabel: v.priceLabel,
    priceBeforeFees: v.priceBeforeFees,
    status: v.status,
    statusLabel: v.statusLabel,
    availability: v.availability,
    location: v.location,
    locationShort: v.locationShort,
    photoCount: v.photoCount,
    mileage: v.mileage,
    type: v.inventoryType,
    carfax: Boolean(v.carfaxUrl),
    dateInStock: typeof v.dateInStock === 'string' && v.dateInStock.trim() ? v.dateInStock : null, // the website's own in-stock date, as it gives it (src/readyList.js reads it)
    decision: assessment.decision,
    reason: assessment.reason,
    blockers: (assessment.blockers || []).map((b) => b.code),
  };
}

// When Lot Current first saw this car: carried over from the last saved
// snapshot; this scan's time for a VIN that was not in it; null on a first
// scan (no last snapshot), meaning the car was already there when Lot Current
// started, so nothing is ever "new" by first sighting on a first scan. An
// entry saved before this field existed carries null too: Lot Current did not
// see that car arrive either. A car the last snapshot still names among its
// missing pages (it left the list on the scan before, confirmed gone or
// not, or is posted and gone: scanRunner.js snapshotOf) was known before,
// so its return is not a first sighting: it carries the sighting the
// snapshot kept for it (missingSeen), else null. A car gone for longer than
// that memory is seen afresh when it comes back.
export function firstSeenAt(previous, vin, takenAt) {
  const last = previous && typeof previous === 'object' && previous.vehicles && typeof previous.vehicles === 'object' ? previous.vehicles : null;
  if (!last) return null;
  const dateOf = (v) => (typeof v === 'string' && v ? v : null);
  const before = last[vin];
  if (before) return dateOf(before.firstSeenAt);
  const missing = previous.missingPages;
  if (missing && typeof missing === 'object' && Object.prototype.hasOwnProperty.call(missing, vin)) {
    const seen = previous.missingSeen;
    return seen && typeof seen === 'object' ? dateOf(seen[vin]) : null;
  }
  return dateOf(takenAt);
}

/**
 * @param {object} args
 *   previous  the last saved snapshot (null on a first scan): each car's
 *             firstSeenAt comes over from it (firstSeenAt above)
 */
export function makeSnapshot({ site, takenAt, complete, vehicles, assessments, previous = null }) {
  const entries = {};
  vehicles.forEach((v, i) => {
    entries[v.vin] = { ...snapshotEntry(v, assessments[i]), firstSeenAt: firstSeenAt(previous, v.vin, takenAt) };
  });
  return { version: 1, site, takenAt, complete: complete !== false, vehicles: entries };
}

function isPending(e) {
  return /pend/i.test(e?.status || '') || /pending|sold/i.test(e?.statusLabel || '');
}

function whatGotReady(before, now) {
  const changes = [];
  if (!before.photoCount && now.photoCount) changes.push('photos added');
  if (!before.price && now.price) changes.push('price added');
  if (before.availability !== now.availability && /in.?stock/i.test(now.availability || '')) changes.push('arrived on the lot');
  if (isPending(before) && !isPending(now)) changes.push('no longer sale-pending');
  if (before.location !== now.location) changes.push(`now at ${now.locationShort || now.location}`);
  if (before.decision === DECISION.REVIEW) changes.push('passed the pre-owned check');
  return changes.length ? changes.join(', ') : 'now ready';
}

/**
 * @param {object|null} prev  previous snapshot (null on the first scan)
 * @param {object} curr       this scan's snapshot
 * @param {object} options
 *   posted:  { [vin]: { price, basis?, postedAt, name, mine? } } cars the salesperson posted;
 *            an entry with `mine: false` is a colleague's (merged in by sync):
 *            its car shows in the lists but is never "yours"
 *   confirm: { checked: [vin], notFound: [vin], error?: string } direct VIN lookups
 *   basis:   'website' | 'beforeFees' which price goes on Marketplace
 *            (a posted listing is compared on its own basis: listingBasis)
 */
export function diffScans(prev, curr, { posted = {}, confirm = null, basis = 'website' } = {}) {
  const out = {
    firstScan: !prev,
    unreliable: false, // true when this scan shouldn't replace the saved one
    warnings: [],
    takeDown: [],
    priceUpdates: [],
    newArrivals: [],
    nowReady: [],
    needsALook: [],
    counts: { previous: prev ? Object.keys(prev.vehicles).length : 0, current: Object.keys(curr.vehicles).length },
  };
  const prevVehicles = prev ? prev.vehicles : {};
  const currVehicles = curr.vehicles;
  const yours = (vin) => Object.prototype.hasOwnProperty.call(posted, vin) && posted[vin]?.mine !== false;

  // 1. Cars that are no longer on the website
  const candidates = new Set([...Object.keys(prevVehicles), ...Object.keys(posted)]);
  const missing = [...candidates].filter((vin) => !currVehicles[vin]);
  const notFound = new Set(confirm && !confirm.error ? confirm.notFound || [] : []);
  const checked = new Set(confirm && !confirm.error ? confirm.checked || [] : []);
  const missingFromLastScan = missing.filter((vin) => prevVehicles[vin]).length;
  const massDisappearance = out.counts.previous >= 10 && missingFromLastScan > out.counts.previous * MASS_DISAPPEARANCE_SHARE;

  if (confirm && confirm.error && missing.length) {
    out.warnings.push(`Couldn't double-check missing cars (${confirm.error}). Nothing was marked as gone.`);
  }
  if (massDisappearance) {
    out.unreliable = true;
    out.warnings.push(
      `${missingFromLastScan} of ${out.counts.previous} cars disappeared at once. That's usually a website hiccup, so nothing was marked as gone. Check the website before taking anything down.`
    );
  }

  for (const vin of missing) {
    const last = prevVehicles[vin] || { vin, name: posted[vin]?.name || vin };
    const item = { vin, name: last.name, stock: last.stock, url: last.url, yours: yours(vin), lastPrice: yours(vin) ? posted[vin].price : basisPrice(last, basis) };
    if (!massDisappearance && notFound.has(vin) && checked.has(vin)) {
      out.takeDown.push({ ...item, why: 'gone', text: 'Gone from the website (sold or removed)' });
    } else {
      out.needsALook.push({ ...item, text: 'Missing from this scan but not confirmed gone. Rescan later.' });
    }
  }

  // 2. Cars on the website now
  for (const [vin, now] of Object.entries(currVehicles)) {
    const before = prevVehicles[vin];
    const mine = yours(vin);
    const nowPrice = basisPrice(now, basis);
    // a posted car's listing price, on the basis that listing was posted with
    const listedNow = mine ? listingWebsitePrice(posted[vin], now, basis, [before, now]) : nowPrice;

    if (mine && isPending(now) && !isPending(before)) {
      out.takeDown.push({ vin, name: now.name, stock: now.stock, url: now.url, yours: true, why: 'sale-pending', text: 'Sale pending on the website', lastPrice: posted[vin].price });
    }

    // Price: posted cars compare with the price on the Marketplace listing
    // (on its own basis, listingBasis), everything else with the last scan.
    const was = mine ? posted[vin].price : before ? basisPrice(before, basis) : undefined;
    if (was !== undefined) {
      if (was && !listedNow) {
        out.needsALook.push({ vin, name: now.name, stock: now.stock, url: now.url, yours: mine, text: `Website no longer shows a price (${now.priceLabel || 'call for price'})` });
      } else if (was && listedNow && was !== listedNow) {
        out.priceUpdates.push({ vin, name: now.name, stock: now.stock, url: now.url, yours: mine, from: was, to: listedNow, change: listedNow - was });
      }
    }

    if (!before) {
      // with the car's dates (the website's in-stock date and this sighting),
      // so the To do tab shows them even when this scan's snapshot is not
      // saved (unreliable above): the diff is saved either way
      if (prev) out.newArrivals.push({ vin, name: now.name, stock: now.stock, url: now.url, decision: now.decision, reason: now.reason, price: nowPrice, dateInStock: now.dateInStock ?? null, firstSeenAt: now.firstSeenAt ?? null });
      continue;
    }

    if (now.decision === DECISION.READY && before.decision !== DECISION.READY && !mine) {
      out.nowReady.push({ vin, name: now.name, stock: now.stock, url: now.url, what: whatGotReady(before, now) });
    }
    if (mine && (now.decision === DECISION.SKIP || now.decision === DECISION.REVIEW) && before.decision !== now.decision) {
      out.needsALook.push({ vin, name: now.name, stock: now.stock, url: now.url, yours: true, text: now.reason });
    }
  }

  // Your listings first, then biggest price moves first
  const yoursFirst = (a, b) => Number(b.yours) - Number(a.yours);
  out.takeDown.sort(yoursFirst);
  out.priceUpdates.sort((a, b) => yoursFirst(a, b) || Math.abs(b.change) - Math.abs(a.change));
  out.needsALook.sort(yoursFirst);
  return out;
}

// Posted-listing bookkeeping. `posted` is a plain object so it stores cleanly.
// `extra` can carry the listing link and who posted (listingUrl, salesperson).
// The entry records the price basis it was posted with (listingBasis).
export function markPosted(posted, entry, basis = 'website', now = new Date().toISOString(), extra = {}) {
  const b = PRICE_BASES.includes(basis) ? basis : 'website';
  return { ...posted, [entry.vin]: { name: entry.name, price: basisPrice(entry, b), basis: b, postedAt: now, ...extra } };
}

// The listing's new price, on the basis it carries (the to-do item's `to`).
export function markPriceUpdated(posted, vin, price, now = new Date().toISOString()) {
  if (!posted[vin]) return posted;
  return { ...posted, [vin]: { ...posted[vin], price, updatedAt: now } };
}

export function markTakenDown(posted, vin) {
  const next = { ...posted };
  delete next[vin];
  return next;
}
