// The pure parts of the lead function (a demo request from the landing page),
// plain JavaScript so Node tests them (test/lead.test.js) and the Deno
// function imports the same file: the field checks, the origin allowlist, and
// the brakes on how many requests arrive (at the end of the file).
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

// ---------- the brakes on how many requests arrive ----------
//
// Two brakes. Per address: at most PER_ADDRESS_PER_HOUR an hour from one
// visitor, kept in one function instance's memory (addressBrake below), so it
// slows one sender down but is not a lock: instances do not share it, and an
// address it has had to forget starts again at zero. Per hour: at most
// PER_HOUR_TOTAL requests in the table, counted across every instance
// (hourlyCapReached below); that is the backstop.

export const HOUR_MS = 3600_000;
export const BRAKE_MAX_KEYS = 5000; // addresses one instance remembers, at most

// Which address a request came from, for the per-address brake. Never
// X-Forwarded-For's leftmost entry: a proxy that forwards a request appends to
// the header the client sent (Cloudflare and Kong both do), so the leftmost
// entry is whatever the client wrote, and a client that writes a new one each
// time never meets the brake. In this order:
//   1. cf-connecting-ip, then x-real-ip: set by the platform's edge from the
//      connection it accepted, replacing any value the client sent;
//   2. the rightmost X-Forwarded-For entry: the address the nearest proxy saw
//      and appended, not one the client wrote;
//   3. 'unknown': every such request shares one key, and the brake holds them
//      all together (PER_ADDRESS_PER_HOUR between them, per instance).
// Which of these headers Supabase's gateway sets itself (and whether it
// appends its own hop to X-Forwarded-For, which would make the rightmost entry
// the gateway's and not the visitor's) is not documented, so it is confirmed on
// the first deploy (supabase/README.md, "Demo requests"); if a header turns
// out to carry what the client sent, change the order here.
// `headers` is anything with get(name): the function passes the Request's.
export function clientAddress(headers) {
  const get = (name) => {
    const value = headers && typeof headers.get === 'function' ? headers.get(name) : null;
    return typeof value === 'string' ? value.trim() : '';
  };
  for (const name of ['cf-connecting-ip', 'x-real-ip']) {
    const value = get(name);
    if (value) return value;
  }
  const hops = get('x-forwarded-for').split(',').map((s) => s.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : 'unknown';
}

// The brake's key for a request: its address (clientAddress), hashed with
// SHA-256 and cut to 12 bytes of hex, so the function's memory holds no
// address, only this.
export async function addressKey(headers) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clientAddress(headers)));
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

// The per-address brake. allow(key) says whether one more request from that
// key fits (at most `limit` in any `windowMs`) and, if it does, counts it. It
// remembers at most `maxKeys` keys and never more: to make room it forgets the
// key it has gone longest without hearing from, so keys that have been quiet
// for a whole window go first, and a client that sends a new address each time
// fills a fixed amount of memory. `now` is the clock, for tests.
export function addressBrake({ limit = PER_ADDRESS_PER_HOUR, windowMs = HOUR_MS, maxKeys = BRAKE_MAX_KEYS, now = Date.now } = {}) {
  const seen = new Map(); // key -> times of its counted requests; the key heard from longest ago first
  return {
    allow(key) {
      const t = now();
      for (const [k, times] of seen) {
        if (t - times[times.length - 1] < windowMs) break;
        seen.delete(k); // nothing from this key inside the window
      }
      const times = (seen.get(key) || []).filter((at) => t - at < windowMs);
      seen.delete(key); // set again below, as the key heard from last
      if (times.length >= limit) {
        if (times.length) seen.set(key, times);
        return false;
      }
      times.push(t);
      while (seen.size >= maxKeys) seen.delete(seen.keys().next().value);
      seen.set(key, times);
      return true;
    },
    get size() {
      return seen.size;
    },
  };
}

// The table-wide cap: true once PER_HOUR_TOTAL requests have arrived in the
// last hour (`count` is the table's count across instances; none counts as 0).
export function hourlyCapReached(count) {
  return (count ?? 0) >= PER_HOUR_TOTAL;
}
