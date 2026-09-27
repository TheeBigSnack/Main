// Decides, for one vehicle, whether it can go on Facebook Marketplace.
//
// Pre-owned check (the gate):
//   Three independent signs from the dealer's own website are compared:
//     1. the inventory type from the dealer's system ("Used", "Certified Used", "New")
//     2. the condition word in the vehicle page address ("used-2019-...", "new-2027-...")
//     3. the condition word at the start of the listing title ("Pre-Owned 2019 ...")
//   Demo and loaner flags always win: those units are sold as new.
//   A Carfax report link counts as a supporting sign of pre-owned, but a missing
//   one never blocks a car (7 of 124 used cars on the test site have none).
//   Mileage is never used to call a car used: the test site has "New" units
//   with 3,000-29,000 miles (demos/loaners that aren't flagged as such).
//   When the signs disagree, or look off, the car goes to "needs a look".
//
// Ready check (only for cars that pass the gate): photos, a price, on the lot,
// not sale-pending, and at the salesperson's own store.

export const DECISION = Object.freeze({
  READY: 'ready', // pre-owned and ready to post
  NOT_READY: 'not-ready', // pre-owned, but something is missing first
  REVIEW: 'review', // signs disagree or look off; a person should check
  SKIP: 'skip', // new, demo or loaner: never post
});

export const LOW_MILES = 100;

// What a condition word says. Only ever given short condition text
// ("Used", "certified used", "Pre-Owned"), never a full title, so model names
// like "New Beetle" can't be misread.
export function readCondition(text) {
  if (typeof text !== 'string' || !text.trim()) return 'unknown';
  const t = text.toLowerCase();
  if (/\b(demo|demonstrator|loaner|courtesy)\b/.test(t)) return 'demo';
  if (/\b(pre-?\s?owned|used|certified|cpo)\b/.test(t)) return 'pre-owned';
  if (/\bnew\b/.test(t)) return 'new';
  return 'unknown';
}

// "Certified Pre-Owned 2022 Jeep Wagoneer" -> "Certified Pre-Owned"
export function titleConditionWords(title) {
  if (typeof title !== 'string') return null;
  const m = title.match(/^\s*(.*?)\s*\b(?:19|20)\d{2}\b/);
  return m && m[1] ? m[1] : null;
}

function describe(checks) {
  return checks.map((c) => `${c.label} says ${c.says}`).join(', ');
}

export function checkPreOwned(v) {
  const titleWords = titleConditionWords(v.siteTitle) || v.readableType || null;
  const checks = [
    { key: 'type', label: 'Inventory type', says: readCondition(v.inventoryType), detail: v.inventoryType || 'missing' },
    { key: 'url', label: 'Web address', says: readCondition(v.urlConditionWord), detail: v.urlConditionWord || 'no condition word' },
    { key: 'title', label: 'Title', says: readCondition(titleWords), detail: titleWords || 'no condition word' },
  ];
  const known = checks.filter((c) => c.says !== 'unknown');
  const saying = (word) => known.filter((c) => c.says === word);
  const preOwned = saying('pre-owned');
  const isNew = saying('new');
  const notes = [];

  if (v.isDemo || v.isLoaner || saying('demo').length) {
    const what = v.isLoaner ? 'loaner' : 'demo';
    if (preOwned.length && !isNew.length) {
      return { verdict: 'review', reason: `Listed as pre-owned but also flagged as a ${what}. Demos and loaners are usually sold as new, so check before posting.`, checks, notes };
    }
    return { verdict: 'new', reason: `${what === 'demo' ? 'Demo' : 'Loaner'} unit, sold as new, so it can't go on Marketplace.`, checks, notes };
  }

  if (isNew.length && !preOwned.length) {
    if (v.carfaxUrl) notes.push('Has a Carfax report even though the website calls it new. If it is really used, fix its type in the inventory system.');
    return { verdict: 'new', reason: "New vehicle. Marketplace doesn't allow dealers to list new cars.", checks, notes };
  }

  if (isNew.length && preOwned.length) {
    return { verdict: 'review', reason: `The website disagrees with itself: ${describe(known)}.`, checks, notes };
  }

  if (!known.length) {
    return { verdict: 'review', reason: "Nothing on the website says whether it's new or used.", checks, notes };
  }

  if (preOwned.length === 1 && !v.carfaxUrl) {
    return { verdict: 'review', reason: `Only one sign it's pre-owned (${preOwned[0].label.toLowerCase()}), and no Carfax report.`, checks, notes };
  }

  if (v.mileage === null || v.mileage === undefined || v.mileage < LOW_MILES) {
    const shown = v.mileage === null || v.mileage === undefined ? 'no mileage' : `${v.mileage} miles`;
    return { verdict: 'review', reason: `Website shows ${shown}. Confirm it's really pre-owned and fix the mileage on the website first. Marketplace needs it.`, checks, notes };
  }

  if (!v.carfaxUrl) notes.push("No Carfax report linked. That's fine: the other checks agree it's pre-owned.");
  return { verdict: 'pre-owned', reason: 'Pre-owned: ' + preOwned.map((c) => c.label.toLowerCase()).join(', ') + (v.carfaxUrl ? ' and Carfax agree.' : ' agree.'), checks, notes };
}

export function readyBlockers(v, settings = {}) {
  const blockers = [];
  if (!v.photoCount) blockers.push({ code: 'no-photos', text: 'No photos on the website yet' });
  if (!v.price) blockers.push({ code: 'no-price', text: `No price on the website (${v.priceLabel || 'call for price'})` });
  if (/pend/i.test(v.status || '') || /pending|sold/i.test(v.statusLabel || '')) blockers.push({ code: 'sale-pending', text: 'Sale pending' });
  if (v.inTransit || (v.availability && !/in.?stock/i.test(v.availability))) blockers.push({ code: 'not-on-lot', text: `Not on the lot yet (${v.availability || 'in transit'})` });
  const myStores = Array.isArray(settings.myStores) ? settings.myStores.filter(Boolean) : [];
  if (myStores.length && v.location && !myStores.includes(v.location)) blockers.push({ code: 'other-store', text: `At ${v.locationShort || v.location}` });
  return blockers;
}

export function assessVehicle(v, settings = {}) {
  const pre = checkPreOwned(v);
  if (pre.verdict === 'new') return { decision: DECISION.SKIP, reason: pre.reason, blockers: [], notes: pre.notes, checks: pre.checks };
  if (pre.verdict === 'review') return { decision: DECISION.REVIEW, reason: pre.reason, blockers: [], notes: pre.notes, checks: pre.checks };
  const blockers = readyBlockers(v, settings);
  return {
    decision: blockers.length ? DECISION.NOT_READY : DECISION.READY,
    reason: blockers.length ? blockers.map((b) => b.text).join('; ') : pre.reason,
    blockers,
    notes: pre.notes,
    checks: pre.checks,
  };
}
