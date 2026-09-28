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
    decision: assessment.decision,
    reason: assessment.reason,
    blockers: (assessment.blockers || []).map((b) => b.code),
  };
}

export function makeSnapshot({ site, takenAt, complete, vehicles, assessments }) {
  const entries = {};
  vehicles.forEach((v, i) => {
    entries[v.vin] = snapshotEntry(v, assessments[i]);
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
 *   posted:  { [vin]: { price, postedAt, name, mine? } } cars the salesperson posted;
 *            an entry with `mine: false` is a colleague's (merged in by sync):
 *            its car shows in the lists but is never "yours"
 *   confirm: { checked: [vin], notFound: [vin], error?: string } direct VIN lookups
 *   basis:   'website' | 'beforeFees' which price goes on Marketplace
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

    if (mine && isPending(now) && !isPending(before)) {
      out.takeDown.push({ vin, name: now.name, stock: now.stock, url: now.url, yours: true, why: 'sale-pending', text: 'Sale pending on the website', lastPrice: posted[vin].price });
    }

    // Price: posted cars compare with the price on the Marketplace listing,
    // everything else with the last scan.
    const was = mine ? posted[vin].price : before ? basisPrice(before, basis) : undefined;
    if (was !== undefined) {
      if (was && !nowPrice) {
        out.needsALook.push({ vin, name: now.name, stock: now.stock, url: now.url, yours: mine, text: `Website no longer shows a price (${now.priceLabel || 'call for price'})` });
      } else if (was && nowPrice && was !== nowPrice) {
        out.priceUpdates.push({ vin, name: now.name, stock: now.stock, url: now.url, yours: mine, from: was, to: nowPrice, change: nowPrice - was });
      }
    }

    if (!before) {
      if (prev) out.newArrivals.push({ vin, name: now.name, stock: now.stock, url: now.url, decision: now.decision, reason: now.reason, price: nowPrice });
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
export function markPosted(posted, entry, basis = 'website', now = new Date().toISOString(), extra = {}) {
  return { ...posted, [entry.vin]: { name: entry.name, price: basisPrice(entry, basis), postedAt: now, ...extra } };
}

export function markPriceUpdated(posted, vin, price, now = new Date().toISOString()) {
  if (!posted[vin]) return posted;
  return { ...posted, [vin]: { ...posted[vin], price, updatedAt: now } };
}

export function markTakenDown(posted, vin) {
  const next = { ...posted };
  delete next[vin];
  return next;
}
