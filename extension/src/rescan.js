// Rescan: compares this scan of the website with the last one, and with the
// cars the salesperson has marked as posted, and turns the differences into
// a to-do list:
//   - take down: cars gone from the website (confirmed by a direct VIN lookup)
//                and posted cars the website marks sale-pending or sold
//                (on every scan while they are still marked posted)
//   - update price: website price went up or down since it was posted / last seen
//   - new arrivals: cars on the website that weren't there last time
//   - now ready: cars that just got photos, a price, arrived on the lot, etc.
//   - needs a look: anything ambiguous (price removed, unconfirmed disappearance),
//                and posted cars the pre-owned check now holds back (every scan)
//
// A car is only called gone when the website's own search can't find its VIN.
// If more than half of a lot of 10 or more disappears at once, nothing is
// marked gone: that is almost always a website hiccup, not a sales record.

import { DECISION } from './classify.js';

export const MASS_DISAPPEARANCE_SHARE = 0.5;
// The share rule applies from this many cars in the last scan up. Below it a
// lot that really sells half its cars in one rescan would otherwise never be
// saved again (an unreliable scan is not saved); a small lot relies on the
// adapter refusing an answer that is not a list (adapters/README.md).
export const MASS_DISAPPEARANCE_MIN_LOT = 10;

// The price to post. 'beforeFees' means the lower second price the website
// shows; when this car has none below its main price, the main price is used
// (a price that is not on the website is never posted). A car with no main
// price ("call for price") has no price on either basis, so the rescan raises
// "Website no longer shows a price" whichever basis the dealer chose.
export function basisPrice(v, basis = 'website') {
  if (!v) return null;
  const main = typeof v.price === 'number' ? v.price : null;
  const lower = typeof v.priceBeforeFees === 'number' && v.priceBeforeFees > 0 ? v.priceBeforeFees : null;
  if (basis !== 'beforeFees' || main === null) return main;
  if (lower !== null && lower < main) return lower;
  return main;
}

export const PRICE_BASES = Object.freeze(['website', 'beforeFees']);

// The basis a posted listing's price was taken on, so its price is compared
// with the website's price on that same basis: the dealer switching Settings
// (Price to post) never makes a price change the website didn't make (rule
// 4). It is recorded on the entry when it was posted (markPosted), or
// stamped on an older entry when the setting changed (withPostedBasis). An
// entry with none (posted before the basis was recorded, or brought by a
// sync: the server doesn't keep it) carries the basis whose website price
// equals its own price on the scans in `seen` (oldest first: the last scan,
// then this one; only scans taken once the listing had its price, scanCar).
// When both bases give the car that price, or neither does, or no scan is
// given, the current setting (`basis`) stands.
export function postedBasis(entry, basis = 'website', seen = []) {
  const own = entry && entry.basis;
  if (PRICE_BASES.includes(own)) return own;
  return seenBasis(entry, seen) || (basis === 'beforeFees' ? 'beforeFees' : 'website');
}

// The basis the scans in `seen` (oldest first) show an entry's price on: the
// one basis that gives the car that price on the first scan where any does.
// null when both do there, when none ever does, or with no price: then
// nothing but the setting is left to go by.
function seenBasis(entry, seen) {
  const price = entry && typeof entry.price === 'number' ? entry.price : null;
  if (price === null) return null;
  for (const v of Array.isArray(seen) ? seen : []) {
    if (!v) continue;
    const matches = PRICE_BASES.filter((b) => basisPrice(v, b) === price);
    if (matches.length === 1) return matches[0];
    if (matches.length) return null;
  }
  return null;
}

// A time as milliseconds, or null when it isn't one.
function msOf(x) {
  const t = typeof x === 'string' && x ? Date.parse(x) : NaN;
  return Number.isFinite(t) ? t : null;
}

// When a posted listing got the price it carries: its last price update
// (updatedAt), else its post (postedAt); null when it carries neither.
function pricedAt(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return msOf(entry.updatedAt) ?? msOf(entry.postedAt);
}

// Whether a scan was taken before a listing got its price: false when
// either time is unknown.
function scanBefore(entry, snap) {
  const priced = pricedAt(entry);
  const taken = snap && typeof snap === 'object' ? msOf(snap.takenAt) : null;
  return priced !== null && taken !== null && taken < priced;
}

// A car as a scan shows it, for reading a listing's basis (seenBasis): only
// a scan taken once the listing had its price can say which website price it
// was given. A scan from before (this computer's last scan, when the car was
// posted or its price updated on another computer and the listing came by
// sync) shows the website as it was then: after a website price cut, the
// price the listing was given can equal the other price on that scan, and
// that reading, kept on the entry (withSeenBasis), would ask for the cut
// again on every scan (rule 4). null for such a scan, for a scan with no
// time when the listing has one, and for a car the scan doesn't hold. A
// listing that carries no time at all can be read off any scan.
function scanCar(entry, snap, vin) {
  const car = snap && snap.vehicles && typeof snap.vehicles === 'object' ? snap.vehicles[vin] : null;
  if (!car) return null;
  const priced = pricedAt(entry);
  if (priced === null) return car;
  const taken = msOf(snap.takenAt);
  return taken !== null && taken >= priced ? car : null;
}

// The posted list with the basis a scan reads off each entry without one
// (seenBasis, from the last scan and this one, as diffScans reads it: only
// scans taken once the listing had its price, scanCar) recorded on that
// entry, so the reading outlives the website's price: once the website moves
// the price so that neither basis gives the listed one, an entry with no
// basis would fall back to the current setting, and a switch of Price to
// post would show up as part of a price change (rule 4). Entries a scan
// can't settle (both bases give the price, or neither does, or no scan since
// the listing got its price holds the car) are left as they are. undefined
// when nothing is recorded, so nothing is written.
export function withSeenBasis(posted, previous, current) {
  if (!posted || typeof posted !== 'object') return undefined;
  let changed = false;
  const next = {};
  for (const [vin, e] of Object.entries(posted)) {
    const read = e && typeof e === 'object' && !PRICE_BASES.includes(e.basis) ? seenBasis(e, [scanCar(e, previous, vin), scanCar(e, current, vin)]) : null;
    if (read) {
      next[vin] = { ...e, basis: read };
      changed = true;
    } else next[vin] = e;
  }
  return changed ? next : undefined;
}

// The website's price now for a posted listing, on the basis the listing
// carries (postedBasis): what Update price and My listings compare with the
// listed price, and what Updated records, so a switch of Price to post never
// reads as a price change in either place. `seen`: the scans the basis of an
// entry without one is read from, oldest first (by default this one).
export function listingWebsitePrice(entry, now, basis = 'website', seen = [now]) {
  return basisPrice(now, postedBasis(entry, basis, seen));
}

// The posted list with a basis stamped on every entry posted before the
// basis was recorded per entry, as the setting changes: the basis its price
// is on in the last scan (`snapshot`; postedBasis), else the basis in force
// until now (`basis`, the setting being changed). An entry that got its
// price after that scan was taken (posted or updated on another computer and
// brought by sync since) is left as it is: the scan shows the website as it
// was before (scanCar), and the next scan reads the entry's basis
// (withSeenBasis). undefined when nothing is stamped, so nothing is written.
export function withPostedBasis(posted, basis, snapshot = null) {
  if (!posted || typeof posted !== 'object') return undefined;
  let changed = false;
  const next = {};
  for (const [vin, e] of Object.entries(posted)) {
    if (e && typeof e === 'object' && !PRICE_BASES.includes(e.basis) && !scanBefore(e, snapshot)) {
      next[vin] = { ...e, basis: postedBasis(e, basis, [scanCar(e, snapshot, vin)]) };
      changed = true;
    } else next[vin] = e;
  }
  return changed ? next : undefined;
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

// What the website says about a car it still lists but no longer sells as
// listed: "Marked sold on the website" when its status word says sold (a
// schema.org SoldOut offer reads "Sold"), "Sale pending on the website" for
// any other pending status; null for a car that is for sale.
export function pendingText(e) {
  if (!isPending(e)) return null;
  return /\bsold\b/i.test(e?.statusLabel || '') && !/pend/i.test(e?.statusLabel || '') ? 'Marked sold on the website' : 'Sale pending on the website';
}

// A posted car's line on My listings, from the last scan's entry for it
// (null when the scan did not have the car), the price on the listing and
// the website price on the dealer's basis. The first that applies: not on
// the website, sold or sale-pending, held back by the pre-owned check (the
// website now calls it new, demo or loaner, or its details need a look),
// a different price, else matching. The same states To do raises on every
// scan while the listing is still marked posted (diffScans).
export function listingStatus(now, listedPrice, sitePrice) {
  if (!now) return { tone: 'bad', text: 'Not on the website at the last scan' };
  const held = pendingText(now);
  if (held) return { tone: 'bad', text: held };
  if (now.decision === DECISION.SKIP) return { tone: 'bad', text: 'Not pre-owned on the website' };
  if (now.decision === DECISION.REVIEW) return { tone: 'warn', text: 'Needs a look (see To do)' };
  // as To do says it (diffScans): the listing has a price the website no longer shows
  if (listedPrice && !sitePrice) return { tone: 'warn', text: 'Website no longer shows a price' };
  if (sitePrice && sitePrice !== listedPrice) return { tone: 'warn', text: 'Website price changed', priceChanged: true };
  return { tone: 'good', text: 'Matches the website' };
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
 *   confirm: { checked: [vin], notFound: [vin], error?: string, unchecked?: { [vin]: reason } }
 *            direct VIN lookups. error: the check as a whole failed, so no
 *            car is called gone; unchecked: cars whose own check failed
 *            while the others' verdicts still stand
 *   basis:   'website' | 'beforeFees' which price goes on Marketplace; a
 *            posted car is compared on the basis recorded on its entry
 *            (postedBasis), so a change of the setting is not a price change
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
  const unchecked = confirm && !confirm.error && confirm.unchecked && typeof confirm.unchecked === 'object' ? confirm.unchecked : {};
  const missingFromLastScan = missing.filter((vin) => prevVehicles[vin]).length;
  const massDisappearance = out.counts.previous >= MASS_DISAPPEARANCE_MIN_LOT && missingFromLastScan > out.counts.previous * MASS_DISAPPEARANCE_SHARE;

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
    } else if (Object.prototype.hasOwnProperty.call(unchecked, vin) && typeof unchecked[vin] === 'string') {
      // its own check failed (the others still counted): say why, and what settles it
      const next = item.yours ? 'Check the car on the website; if it sold, take your listing down and click Taken down on My listings.' : 'Check the car on the website.';
      out.needsALook.push({ ...item, text: `Missing from this scan, and ${unchecked[vin].slice(0, 160)}, so it was not marked gone. ${next}` });
    } else {
      out.needsALook.push({ ...item, text: 'Missing from this scan but not confirmed gone. Rescan later.' });
    }
  }

  // 2. Cars on the website now
  for (const [vin, now] of Object.entries(currVehicles)) {
    const before = prevVehicles[vin];
    const mine = yours(vin);
    // a posted car on the basis its listing was posted at (postedBasis; an
    // entry with none reads it off the last scan, then this one, each only
    // when taken once the listing had its price: scanCar)
    const nowPrice = mine ? listingWebsitePrice(posted[vin], now, basis, [scanCar(posted[vin], prev, vin), scanCar(posted[vin], curr, vin)]) : basisPrice(now, basis);

    // A posted car the website marks sold or sale-pending, or no longer
    // calls pre-owned, is raised on every scan while it is still marked
    // posted, not only on the scan where it changed: each save replaces the
    // whole diff, so a one-scan item would leave To do, the badge and the
    // pilot's open flag while the listing is still up. Taken down (or the
    // website changing back) is what ends it.
    const held = mine ? pendingText(now) : null;
    if (held) {
      out.takeDown.push({ vin, name: now.name, stock: now.stock, url: now.url, yours: true, why: 'sale-pending', text: held, lastPrice: posted[vin].price });
    }
    if (mine && (now.decision === DECISION.SKIP || now.decision === DECISION.REVIEW)) {
      out.needsALook.push({ vin, name: now.name, stock: now.stock, url: now.url, yours: true, text: now.reason });
    }

    // Price: posted cars compare with the price on the Marketplace listing
    // (on its own basis, postedBasis), everything else with the last scan.
    const was = mine ? posted[vin].price : before ? basisPrice(before, basis) : undefined;
    if (was !== undefined) {
      if (was && !nowPrice) {
        out.needsALook.push({ vin, name: now.name, stock: now.stock, url: now.url, yours: mine, text: `Website no longer shows a price (${now.priceLabel || 'call for price'})` });
      } else if (was && nowPrice && was !== nowPrice) {
        out.priceUpdates.push({ vin, name: now.name, stock: now.stock, url: now.url, yours: mine, from: was, to: nowPrice, change: nowPrice - was });
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
  }

  // Your listings first, then biggest price moves first
  const yoursFirst = (a, b) => Number(b.yours) - Number(a.yours);
  out.takeDown.sort(yoursFirst);
  out.priceUpdates.sort((a, b) => yoursFirst(a, b) || Math.abs(b.change) - Math.abs(a.change));
  out.needsALook.sort(yoursFirst);
  return out;
}

/**
 * A scan's diff checked against the posted list as it is stored now, just
 * before the diff is saved. A rescan can run for minutes, and meanwhile the
 * salesperson may tick an item off (Taken down, Updated) or the side panel
 * may finish one: a diff worked out from the posted list read when the scan
 * began would put that item back on To do. So the salesperson's own items
 * (yours) are dropped when their car is no longer posted as theirs, and a
 * price item when the listing already carries the new price. Items about
 * colleagues' cars and the rest of the lot are kept as they are.
 */
export function settleDiff(diff, posted) {
  if (!diff || typeof diff !== 'object') return diff;
  const now = posted && typeof posted === 'object' ? posted : {};
  const stillYours = (vin) => Object.prototype.hasOwnProperty.call(now, vin) && now[vin]?.mine !== false;
  const keep = (item) => !item || !item.yours || stillYours(item.vin);
  const out = { ...diff };
  for (const list of ['takeDown', 'needsALook']) if (Array.isArray(diff[list])) out[list] = diff[list].filter(keep);
  if (Array.isArray(diff.priceUpdates)) out.priceUpdates = diff.priceUpdates.filter((u) => keep(u) && !(u && u.yours && now[u.vin].price === u.to));
  return out;
}

// Posted-listing bookkeeping. `posted` is a plain object so it stores cleanly.
// `extra` can carry the listing link and who posted (listingUrl, salesperson).
// The entry records the price basis it was posted with (postedBasis).
export function markPosted(posted, entry, basis = 'website', now = new Date().toISOString(), extra = {}) {
  return { ...posted, [entry.vin]: { name: entry.name, price: basisPrice(entry, basis), basis: postedBasis(null, basis), postedAt: now, ...extra } };
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
