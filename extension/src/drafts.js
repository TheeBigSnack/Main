// Cars saved as Facebook drafts (the side panel's "Saved as draft, next
// car"). A draft keeps the price it was filled with: the listing published
// from it later shows that price, whatever the website says by then. So
// "Mark posted" on a draft's car records the draft's price, and a website
// price that moved while the draft waited becomes a price to update (on To
// do at once, and on every rescan after: src/rescan.js diffScans compares
// the website with the recorded price), never a silent gap. Pure helpers;
// no chrome.*.

import { basisPrice, markPosted } from './rescan.js';

const money = (n) => '$' + Math.round(n).toLocaleString('en-US');

// The record kept for a car saved as a draft: the price the form was filled
// with, on the price basis it was filled under.
export function draftRecord({ name, price, basis, savedAt }) {
  return { name, savedAt, price: draftPrice({ price }), basis: basis === 'beforeFees' ? 'beforeFees' : 'website' };
}

// The price the draft was filled with; null for a draft saved before drafts
// kept their price (or anything else that is not a price).
export function draftPrice(draft) {
  const p = draft && typeof draft === 'object' ? draft.price : null;
  return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null;
}

// Mark posted on a car saved as a draft: the posted entry, at the draft's
// price when the draft kept one, else at the website's price (as for any
// listing marked by hand).
export function markDraftPosted(posted, entry, draft, basis = 'website', now = new Date().toISOString(), extra = {}) {
  const next = markPosted(posted, entry, basis, now, extra);
  const price = draftPrice(draft);
  return price === null ? next : { ...next, [entry.vin]: { ...next[entry.vin], price } };
}

// The price update a draft's car needs once its draft is published, shaped
// like a diffScans price update for one of your listings. Null when the
// draft's price and the website's (on the chosen basis) agree, or either is
// unknown.
export function draftPriceUpdate(draft, entry, basis = 'website') {
  const from = draftPrice(draft);
  const to = basisPrice(entry, basis);
  if (from === null || !entry || typeof to !== 'number' || !(to > 0) || from === to) return null;
  return { vin: entry.vin, name: entry.name, stock: entry.stock, url: entry.url, yours: true, from, to, change: to - from };
}

// The saved to-do list (the diff) with this price update in it, in place of
// any other for the same car, in diffScans' order (your listings first,
// then the biggest moves). Undefined when there is no saved list.
export function withPriceUpdate(diff, item) {
  if (!diff || typeof diff !== 'object' || !item) return undefined;
  const list = (Array.isArray(diff.priceUpdates) ? diff.priceUpdates : []).filter((p) => p && p.vin !== item.vin);
  list.push(item);
  list.sort((a, b) => Number(b.yours) - Number(a.yours) || Math.abs(b.change) - Math.abs(a.change));
  return { ...diff, priceUpdates: list };
}

// The pill a draft's car shows in place of Post: the draft's price, and a
// warning when the website's price moved or the car is not ready any more.
// markWhere: where Mark posted is ('' in the popup, ' in the popup' from the
// side panel). tone is the pill's class: 'warn', or 'bad' when the draft
// should not be published as it is.
export function draftPill(draft, entry, { basis = 'website', ready = true, markWhere = '' } = {}) {
  const at = draftPrice(draft);
  const already = `Already published it? Mark it posted${markWhere} so rescans watch it.`;
  if (!ready) {
    return { tone: 'bad', text: 'Draft on Facebook: not ready now', title: `This car is not ready to post now. Don't publish the draft: delete it on Facebook, or wait until the car is ready again. ${already}` };
  }
  const gap = draftPriceUpdate(draft, entry, basis);
  if (gap) {
    return {
      tone: 'bad',
      text: `Draft on Facebook at ${money(gap.from)}: the website now shows ${money(gap.to)}`,
      title: `Change the price on the draft to ${money(gap.to)} before you publish it. Already published it? Mark it posted${markWhere}: it is recorded at ${money(gap.from)} and To do lists the price to update.`,
    };
  }
  if (at === null) {
    return { tone: 'warn', text: 'Draft on Facebook', title: `Saved as a draft on Facebook. Lot Current did not keep this draft's price, so check it against the website before you publish it there; then mark it posted${markWhere}.` };
  }
  return { tone: 'warn', text: `Draft on Facebook at ${money(at)}`, title: `Saved as a draft on Facebook: publish it there, then mark it posted${markWhere}.` };
}
