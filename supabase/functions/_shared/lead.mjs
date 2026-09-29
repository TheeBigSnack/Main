// The pure parts of the lead function (a demo request from the landing page),
// plain JavaScript so Node tests them (test/lead.test.js) and the Deno
// function imports the same file.
//
// A request is { name, dealership, website, email, phone?, message?,
// company_url? }, as site/index.html's form names its fields. company_url is
// the honeypot: a field people never see (off screen, out of the tab order),
// which form-filling bots fill; a request with it filled is answered as a
// success and stored nowhere, so the bot learns nothing.

export const LEAD_LIMITS = Object.freeze({
  name: 80,
  dealership: 120,
  website: 200,
  email: 200,
  phone: 40,
  message: 2000,
});
export const HONEYPOT = 'company_url';
export const PER_ADDRESS_PER_HOUR = 5; // one visitor's address, per function instance
export const PER_HOUR_TOTAL = 200; // every request in the table, across instances: a flood stops here

const isRecord = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);

// Text as a person typed it: no control characters (a newline stays in the
// message), no surrounding spaces, at most `max` characters.
export function clean(value, max, { multiline = false } = {}) {
  if (typeof value !== 'string') return '';
  const kept = multiline ? value.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '') : value.replace(/[\u0000-\u001F\u007F]/g, ' ');
  return kept.trim().slice(0, max);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Checks and trims a request.
 * @returns {{ ok: true, bot: boolean, lead?: object } | { ok: false, error: string, field: string }}
 *   bot: the honeypot was filled; answer as a success and store nothing.
 */
export function validateLead(body) {
  if (!isRecord(body)) return { ok: false, error: 'send the form as a JSON object', field: '' };
  if (typeof body[HONEYPOT] === 'string' && body[HONEYPOT].trim() !== '') return { ok: true, bot: true };
  const lead = {
    name: clean(body.name, LEAD_LIMITS.name),
    dealership: clean(body.dealership, LEAD_LIMITS.dealership),
    website: clean(body.website, LEAD_LIMITS.website),
    email: clean(body.email, LEAD_LIMITS.email).toLowerCase(),
    phone: clean(body.phone, LEAD_LIMITS.phone),
    message: clean(body.message, LEAD_LIMITS.message, { multiline: true }),
  };
  for (const field of ['name', 'dealership', 'website', 'email']) {
    if (!lead[field]) return { ok: false, error: `the ${field} is missing`, field };
  }
  if (!EMAIL.test(lead.email)) return { ok: false, error: 'that email address does not look right', field: 'email' };
  if (!/^(https?:\/\/)?[^\s/]+\.[^\s]+$/i.test(lead.website)) return { ok: false, error: 'that website address does not look right', field: 'website' };
  if (lead.phone && !/^[0-9+().\-\s x]{7,}$/i.test(lead.phone)) return { ok: false, error: 'that phone number does not look right', field: 'phone' };
  return { ok: true, bot: false, lead };
}

// The origins allowed to send a request (the landing page's own), from the
// LEAD_ORIGINS secret: comma separated, compared exactly (scheme and host).
export function parseOrigins(text) {
  return String(text || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter((s) => /^https?:\/\/[^/\s]+$/i.test(s));
}

export function originAllowed(origin, allowed) {
  return typeof origin === 'string' && origin !== '' && allowed.includes(origin.replace(/\/+$/, ''));
}
