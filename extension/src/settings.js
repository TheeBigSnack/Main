// Settings shared by the popup and the side panel, with defaults so a
// settings object saved by v0.1 ({ myStores, basis }) keeps working.

import { shortLocation } from './normalize.js';
import { DEFAULT_DAILY_CAP } from './cap.js';

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
  return {
    version: SETTINGS_VERSION,
    myStores,
    basis: s.basis === 'beforeFees' ? 'beforeFees' : 'website',
    salesperson: { name: String(sp.name || ''), title: String(sp.title || 'sales consultant') },
    dealer: {
      name: String(d.name || site.name || ''),
      city: String(d.city || (myStores[0] ? shortLocation(myStores[0]) : '')),
      state: String(d.state || ''),
      zip: String(d.zip || ''),
    },
    priceNote: typeof s.priceNote === 'string' ? s.priceNote : '',
    dailyCap: Number.isFinite(s.dailyCap) && s.dailyCap > 0 ? Math.floor(s.dailyCap) : DEFAULT_DAILY_CAP,
    rewrite: { enabled: Boolean(rw.enabled), endpoint: String(rw.endpoint || ''), key: String(rw.key || '') },
  };
}

export function defaultSettings(site, vehicles) {
  const locations = [...new Set((vehicles || []).map((v) => v.location).filter(Boolean))];
  const mine = locations.filter((l) => l === site.name || (site.title || '').includes(l));
  return withDefaults({ myStores: mine, priceNote: suggestedPriceNote(feeGap(vehicles).gap, 'website') }, site);
}
