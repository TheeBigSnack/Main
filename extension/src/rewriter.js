// Gets a description for one car. The built-in template always works with no
// network. Only when the dealer has switched on the rewrite service in
// Settings (and given its address) is Claude asked, through the Lot Sync
// backend, never directly: no API key ever lives in the extension. Whatever
// comes back is checked against the website's facts; if it fails, the
// template is used.

import { cleanDescription } from './description.js';
import { buildTemplateDescription, runGuardrails, ensureVinLine } from './rewriteTemplate.js';

export const REWRITE_TIMEOUT_MS = 25000;

// Asks the service to look at the car's photos and pick colors from
// Facebook's list. Only used when the website gives no usable color, and the
// result is shown as a guess. Nothing but the photo addresses and the list
// leaves the browser.
export async function guessColorsWithBackend({ endpoint, key = '', photos, options, fetchImpl = globalThis.fetch, timeoutMs = REWRITE_TIMEOUT_MS }) {
  const url = String(endpoint || '').replace(/\/+$/, '') + '/color';
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ photos: (photos || []).slice(0, 4), options }),
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

// Exactly what leaves the browser: facts about the car and the dealer.
// No VIN, no Facebook data, nothing about the salesperson beyond the sign-off.
export function rewriteFacts({ vehicle: v, dealer = {}, salesperson = {}, priceNote = '', narrative = [] }) {
  return {
    year: v.year, make: v.make, model: v.model, trim: v.trim, mileage: v.mileage, stock: v.stock,
    features: Array.isArray(v.features) ? v.features : [],
    carfaxOneOwner: v.carfaxOneOwner === true,
    carfax: Boolean(v.carfaxUrl),
    exteriorColor: v.exteriorColor, interiorColor: v.interiorColor, bodyType: v.bodyType,
    engine: v.engine, transmission: v.transmission, drivetrain: v.drivetrain, fuelType: v.fuelType,
    narrative,
    dealer: { name: dealer.name || '', city: dealer.city || '' },
    salesperson: { name: salesperson.name || '', title: salesperson.title || 'sales consultant' },
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
 * @returns {{ text, source: 'template'|'claude', model?, guardrails, narrative, note? }}
 */
export async function generateDescription({ vehicle, dealer = {}, salesperson = {}, priceNote = '', price = null, boilerplate = [], settings = {}, fetchImpl }) {
  const narrative = cleanDescription(vehicle.descriptionRaw, new Set(boilerplate));
  const ctx = { vehicle, dealer, priceNote, price };
  const template = buildTemplateDescription({ vehicle, dealer, salesperson, priceNote, narrative });
  const fallback = { text: template, source: 'template', guardrails: runGuardrails(template, ctx), narrative };
  const rw = settings.rewrite || {};
  if (!rw.enabled || !rw.endpoint) return fallback;
  const facts = rewriteFacts({ vehicle, dealer, salesperson, priceNote, narrative });
  try {
    const r = await rewriteWithBackend({ endpoint: rw.endpoint, key: rw.key, facts, fetchImpl });
    if (r.ok && r.text) {
      const text = ensureVinLine(r.text, vehicle.vin); // the VIN never goes to the service; it is added here
      const g = runGuardrails(text, ctx);
      if (g.ok) return { text, source: 'claude', model: r.model, guardrails: g, narrative };
      return { ...fallback, note: `Claude's draft failed a check (${g.problems.map((p) => p.text).join('; ')}), so the template is shown instead.` };
    }
    return { ...fallback, note: `The rewrite service couldn't help (${r.error || 'no text came back'}), so the template is shown instead.` };
  } catch (e) {
    return { ...fallback, note: `Couldn't reach the rewrite service (${(e && e.message) || e}), so the template is shown instead.` };
  }
}
