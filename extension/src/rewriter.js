// Gets a description for one car. The built-in template always works with no
// network. Only when the dealer has switched on the rewrite service in
// Settings (and given its address) is Claude asked, through the Lot Current
// backend, never directly: no API key ever lives in the extension. Whatever
// comes back is checked against the website's facts; if it fails, the
// template is used.

import { DEFAULT_SALESPERSON_TITLE } from './settings.js';
import { cleanDescription } from './description.js';
import { buildTemplateDescription, runGuardrails, ensureVinLine, ensureClosingLine, usableClosingLine, settleHighlights } from './rewriteTemplate.js';
import { carStore } from './listingData.js';

export const REWRITE_TIMEOUT_MS = 25000;

// Asks the service to look at the car's photos and pick colors from
// Facebook's list. Only used when the website gives no usable color, and the
// result is shown as a guess. Nothing but the photo addresses, the list and
// the dealer website's origin (which store to bill, as with the facts; the
// service never passes it on) leaves the browser.
export async function guessColorsWithBackend({ endpoint, key = '', photos, options, origin = '', fetchImpl = globalThis.fetch, timeoutMs = REWRITE_TIMEOUT_MS }) {
  const url = String(endpoint || '').replace(/\/+$/, '') + '/color';
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ photos: (photos || []).slice(0, 4), options, ...(origin ? { origin: String(origin) } : {}) }),
      signal: controller ? controller.signal : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) return { ok: false, error: body.error || `the service returned ${res.status}` };
    const pick = (val) => (options || []).find((o) => o.toLowerCase() === String(val || '').trim().toLowerCase()) || '';
    return { ok: true, exterior: pick(body.exterior), interior: pick(body.interior), confidence: body.confidence || 'low', model: body.model || '' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Exactly what leaves the browser: facts about the car and the dealer (plus
// the dealer website's origin, added by generateDescription, so the service
// knows which store the car belongs to). No VIN or price field, no Facebook
// data, nothing about the salesperson beyond the sign-off (their closing line
// is added to the draft here, like the VIN). `narrative` is the website
// description's own sentences as the website wrote them, so a VIN, a price
// or a phone number the dealership wrote there goes with them. When the
// salesperson picked the highlights, those are the features the service sees.
export function rewriteFacts({ vehicle: v, dealer = {}, salesperson = {}, priceNote = '', narrative = [], highlights = null }) {
  return {
    year: v.year, make: v.make, model: v.model, trim: v.trim, mileage: v.mileage, stock: v.stock,
    features: Array.isArray(highlights) ? settleHighlights(highlights, v.features) : Array.isArray(v.features) ? v.features : [],
    ...(Array.isArray(highlights) ? { highlightsPicked: true } : {}),
    carfaxOneOwner: v.carfaxOneOwner === true,
    carfax: Boolean(v.carfaxUrl),
    exteriorColor: v.exteriorColor, interiorColor: v.interiorColor, bodyType: v.bodyType,
    engine: v.engine, transmission: v.transmission, drivetrain: v.drivetrain, fuelType: v.fuelType,
    narrative,
    dealer: { name: dealer.name || '', city: dealer.city || '' },
    salesperson: { name: salesperson.name || '', title: salesperson.title || DEFAULT_SALESPERSON_TITLE },
    priceNote,
  };
}

export async function rewriteWithBackend({ endpoint, key = '', facts, fetchImpl = globalThis.fetch, timeoutMs = REWRITE_TIMEOUT_MS }) {
  const url = String(endpoint || '').replace(/\/+$/, '') + '/rewrite';
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(facts),
      signal: controller ? controller.signal : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, text: body.text || '', error: body.error || `the service returned ${res.status}` };
    const ok = Boolean(body.ok && body.text);
    return { ok, text: body.text || '', model: body.model || '', problems: (body.guardrails && body.guardrails.problems) || [], error: ok ? '' : body.error || 'the draft failed the service checks' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * `origin` is the dealer website's origin; it goes to the service with the
 * facts, so a person who belongs to two stores is billed and capped against
 * the right one. `highlights` is the salesperson's pick of the car's
 * features (null: the usual pick); `salesperson.closingLine` ends every
 * description when it passes its checks.
 * @returns {{ text, source: 'template'|'claude', model?, guardrails, narrative, note? }}
 */
export async function generateDescription({ vehicle, dealer = {}, salesperson = {}, priceNote = '', price = null, boilerplate = [], settings = {}, origin = '', highlights = null, fetchImpl }) {
  // the write-up up to the first part it leaves out (lot-wide text, a label, an award line, a list): the rewrite
  // service gets it; the template writes from the car's listed facts and never copies it
  const narrative = cleanDescription(vehicle.descriptionRaw, new Set(boilerplate));
  const closingLine = usableClosingLine(salesperson.closingLine);
  const ctx = { vehicle, dealer, salesperson, priceNote, price, closingLine };
  const stores = Array.isArray(settings.myStores) ? settings.myStores : [];
  const template = buildTemplateDescription({ vehicle, dealer, salesperson, priceNote, highlights, stores });
  const fallback = { text: template, source: 'template', guardrails: runGuardrails(template, ctx), narrative };
  const rw = settings.rewrite || {};
  if (!rw.enabled || !rw.endpoint) return fallback;
  // no draft can name a dealership that has no name: the service is not asked (and not paid)
  if (!String(dealer.name || '').trim()) return { ...fallback, note: "The dealership's name isn't set in Settings, so the rewrite service wasn't asked." };
  // The service knows the dealership's name and town, not the car's store, so
  // for a car the website lists at a store in another town it could only say
  // the car is somewhere it isn't: the template, which names the car's store, is used.
  const where = carStore(vehicle, { stores, dealer });
  if (where.away) return { ...fallback, note: `The website lists this car at ${where.store}, which may not be at your dealership's address, so the template wrote the description: it names the car's own store. If it is your store, tick it in Settings.` };
  const facts = { ...rewriteFacts({ vehicle, dealer, salesperson, priceNote, narrative, highlights }), ...(origin ? { origin: String(origin) } : {}) };
  try {
    const r = await rewriteWithBackend({ endpoint: rw.endpoint, key: rw.key, facts, fetchImpl });
    if (r.ok && r.text) {
      const text = ensureVinLine(ensureClosingLine(r.text, closingLine), vehicle.vin); // neither the closing line nor the VIN goes to the service; both are added here
      const g = runGuardrails(text, ctx);
      if (g.ok) return { text, source: 'claude', model: r.model, guardrails: g, narrative };
      return { ...fallback, note: `Claude's draft failed a check (${g.problems.map((p) => p.text).join('; ')}), so the template is shown instead.` };
    }
    return { ...fallback, note: `The rewrite service couldn't help (${r.error || 'no text came back'}), so the template is shown instead.` };
  } catch (e) {
    return { ...fallback, note: `Couldn't reach the rewrite service (${(e && e.message) || e}), so the template is shown instead.` };
  }
}
